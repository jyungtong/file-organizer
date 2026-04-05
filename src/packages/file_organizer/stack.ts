/// <reference path="../../../../.sst/platform/config.d.ts" />

/**
 * File Organizer stack — all AWS resources for the Telegram bot.
 * Called from sst.config.ts via: await import('./src/packages/file_organizer/stack')
 */
export async function run() {
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
    memory: '512 MB',
    link: [table],
    environment: {
      TELEGRAM_BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN ?? '',
      CLAUDE_API_KEY: process.env.CLAUDE_API_KEY ?? '',
      GOOGLE_CLIENT_ID: process.env.GOOGLE_CLIENT_ID ?? '',
      GOOGLE_CLIENT_SECRET: process.env.GOOGLE_CLIENT_SECRET ?? '',
      // Set after deploy: the Function URL itself (used as OAuth redirect URI)
      GOOGLE_REDIRECT_URI: process.env.GOOGLE_REDIRECT_URI ?? '',
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
