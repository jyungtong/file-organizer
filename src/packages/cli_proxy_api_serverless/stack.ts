/// <reference path="../../../../.sst/platform/config.d.ts" />

/**
 * CLI Proxy API Serverless stack — containerised Lambda fronting the CLI proxy.
 * Called from sst.config.ts via: await import('./src/packages/cli_proxy_api_serverless/stack')
 */
export async function run() {
  const claudeTokenJson = new sst.Secret('CLAUDE_TOKEN_JSON');

  const aws = await import('@pulumi/aws');
  const dockerBuild = await import('@pulumi/docker-build');

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
        // Key clients use to authenticate with this proxy
        PROXY_API_KEY: process.env.PROXY_API_KEY ?? '123456',
        // Option A: direct Anthropic API key
        // CLAUDE_API_KEY: process.env.CLAUDE_API_KEY ?? '',
        // Option B: Claude OAuth token JSON (from `claude login` flow)
        // e.g. {"access_token":"...","refresh_token":"...","email":"...","type":"claude"}
        CLAUDE_TOKEN_JSON: claudeTokenJson.value,
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
