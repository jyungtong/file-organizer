/// <reference path="../../../../.sst/platform/config.d.ts" />

/**
 * File Organizer stack — all AWS resources for the Telegram bot.
 * Called from sst.config.ts via: await import('./src/packages/file_organizer/stack')
 */
export async function run() {
  // ─── Secrets ──────────────────────────────────────────────────────────────
  const botToken = new sst.Secret('TELEGRAM_BOT_TOKEN');
  const googleClientId = new sst.Secret('GOOGLE_CLIENT_ID');
  const googleClientSecret = new sst.Secret('GOOGLE_CLIENT_SECRET');
  const googleRedirectUri = new sst.Secret('GOOGLE_REDIRECT_URI', 'xxx');

  // ─── DynamoDB table ───────────────────────────────────────────────────────
  // Single-table design: PK = USER#<userId>, SK = STATE | OAUTH | RULE#<ruleId>

  const table = new sst.aws.Dynamo('FileOrganizerTable', {
    fields: { pk: 'string', sk: 'string' },
    primaryIndex: { hashKey: 'pk', rangeKey: 'sk' },
    // TTL on the 'ttl' attribute — used for pending confirmation expiry
    ttl: 'ttl',
  });

  const fn = new sst.aws.Function('TelegramBot', {
    handler: 'src/packages/file_organizer/handler.handler',
    runtime: 'nodejs24.x',
    architecture: 'arm64',
    timeout: '30 seconds',
    memory: '1024 MB',
    link: [
      table,
      botToken,
      googleClientId,
      googleClientSecret,
      googleRedirectUri,
    ],
    environment: {
      TELEGRAM_BOT_TOKEN: botToken.value,
      CLAUDE_API_KEY: process.env.CLAUDE_API_KEY ?? '',
      GOOGLE_CLIENT_ID: googleClientId.value,
      GOOGLE_CLIENT_SECRET: googleClientSecret.value,
      GOOGLE_REDIRECT_URI: googleRedirectUri.value,
    },
    url: {
      cors: {
        allowOrigins: ['*'],
        allowMethods: ['POST', 'GET'],
        allowHeaders: ['content-type'],
      },
    },
  });

  return {
    webhookUrl: fn.url,
    tableName: table.name,
  };
}
