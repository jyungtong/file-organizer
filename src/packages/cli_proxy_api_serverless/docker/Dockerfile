FROM eceasy/cli-proxy-api:latest

# Lambda Web Adapter: acts as the Lambda runtime and forwards HTTP events to our app
COPY --from=public.ecr.aws/awsguru/aws-lambda-adapter:1.0.0 /lambda-adapter /opt/extensions/lambda-adapter

ENV AWS_LWA_PORT=8317

COPY config.yaml /CLIProxyAPI/config.yaml

COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh
ENTRYPOINT ["/entrypoint.sh"]
