/// <reference path="./.sst/platform/config.d.ts" />

export default $config({
  app(input) {
    return {
      name: 'file-organizer',
      removal: input?.stage === 'production' ? 'retain' : 'remove',
      protect: ['production'].includes(input?.stage),
      home: 'aws',
    };
  },
  async run() {
    // ── File Organizer (Telegram bot) ────────────────────────────────────────
    const fileOrganizer = await import('./src/packages/file_organizer/stack');
    const { webhookUrl, tableName } = await fileOrganizer.run();

    // ── CLI Proxy API (containerised Lambda) ─────────────────────────────────
    const cliProxy = await import(
      './src/packages/cli_proxy_api_serverless/stack'
    );
    const { proxyUrl } = await cliProxy.run();

    return {
      proxyUrl,
      telegramWebhookUrl: webhookUrl,
      fileOrganizerTable: tableName,
    };
  },
});
