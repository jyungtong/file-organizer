/// <reference path="../../../../.sst/platform/config.d.ts" />

/**
 * CLI Proxy API Serverless stack — containerised Lambda fronting the CLI proxy.
 * Called from sst.config.ts via: await import('./src/packages/cli_proxy_api_serverless/stack')
 */
export async function run() {
  const aws = await import('@pulumi/aws');
  const dockerBuild = await import('@pulumi/docker-build');

  // SST-managed S3 bucket for object store
  const objectStore = new sst.aws.Bucket('CLIProxyObjectStore');

  // ECR repository to host the container image
  const repo = new aws.ecr.Repository('cli-proxy-repo', {
    forceDelete: true,
  });

  // ECR auth token for pushing the image
  const authToken = aws.ecr.getAuthorizationTokenOutput({
    registryId: repo.registryId,
  });

  // Build the Docker image and push to ECR.
  // push: false + explicit exports is required because push: true uses OCI media types
  // by default (provenance attestation), which Lambda rejects. ociMediaTypes: false
  // forces Docker manifest v2 format which Lambda requires.
  const image = new dockerBuild.Image('CLIProxyImage', {
    push: false,
    context: {
      location: `${process.cwd()}/src/packages/cli_proxy_api_serverless/docker`,
    },
    platforms: [dockerBuild.Platform.Linux_arm64],
    exports: [
      {
        registry: {
          ociMediaTypes: false,
          push: true,
          names: [$interpolate`${repo.repositoryUrl}:latest`],
        },
      },
    ],
    registries: [
      {
        address: repo.repositoryUrl,
        username: authToken.userName,
        password: authToken.password,
      },
    ],
  });

  // IAM execution role for the Lambda function
  const role = new aws.iam.Role('CLIProxyRole', {
    assumeRolePolicy: aws.iam.assumeRolePolicyForPrincipal({
      Service: 'lambda.amazonaws.com',
    }),
  });

  new aws.iam.RolePolicyAttachment('CLIProxyRolePolicy', {
    role: role.name,
    policyArn: aws.iam.ManagedPolicy.AWSLambdaBasicExecutionRole,
  });

  // IAM user for object store access (scoped to the bucket)
  const objectStoreUser = new aws.iam.User('CLIProxyObjectStoreUser', {});
  new aws.iam.UserPolicy('CLIProxyObjectStoreUserPolicy', {
    user: objectStoreUser.name,
    policy: objectStore.arn.apply((arn) =>
      JSON.stringify({
        Version: '2012-10-17',
        Statement: [
          {
            Effect: 'Allow',
            Action: ['s3:*'],
            Resource: [arn, `${arn}/*`],
          },
        ],
      }),
    ),
  });

  // Access key for the object store user
  const objectStoreKey = new aws.iam.AccessKey('CLIProxyObjectStoreKey', {
    user: objectStoreUser.name,
  });

  // Lambda function using the container image.
  // Use image.digest (not :latest tag) so Pulumi knows to update Lambda when the image changes.
  const fn = new aws.lambda.Function('CLIProxy', {
    packageType: 'Image',
    imageUri: $interpolate`${repo.repositoryUrl}@${image.digest}`,
    role: role.arn,
    architectures: ['arm64'],
    timeout: 60,
    memorySize: 512,
    environment: {
      variables: {
        // Ensure no warm instance after new deployment
        // because cliproxyapi doesn't restart on new deployment without this
        DEPLOY_TIME: new Date().toISOString(),
        // Key clients use to authenticate with this proxy
        PROXY_API_KEY: process.env.PROXY_API_KEY ?? '123456',
        OBJECTSTORE_ENDPOINT: `https://s3.${aws.config.region}.amazonaws.com`,
        OBJECTSTORE_BUCKET: objectStore.name,
        OBJECTSTORE_ACCESS_KEY: objectStoreKey.id,
        OBJECTSTORE_SECRET_KEY: objectStoreKey.secret,
        OBJECTSTORE_LOCAL_PATH: '/tmp/.cli-proxy-api',
      },
    },
  });

  // TODO: auth
  // Public Function URL — no IAM auth for POC
  const fnUrl = new aws.lambda.FunctionUrl('CLIProxyUrl', {
    functionName: fn.name,
    authorizationType: 'NONE',
    cors: {
      allowOrigins: ['*'],
      allowMethods: ['*'],
      allowHeaders: ['*'],
    },
  });

  return {
    proxyUrl: fnUrl.functionUrl,
  };
}
