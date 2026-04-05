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
    // ── CLI Proxy API (containerised Lambda) ─────────────────────────────────
    // Must run first so proxyUrl can be passed to the File Organizer Lambda.
    const cliProxy = await import(
      './src/packages/cli_proxy_api_serverless/stack'
    );
    const { proxyUrl } = await cliProxy.run();

    // ── File Organizer (Telegram bot) ────────────────────────────────────────
    const fileOrganizer = await import('./src/packages/file_organizer/stack');
    const { webhookUrl, tableName } = await fileOrganizer.run(proxyUrl);

    return {
      proxyUrl,
      telegramWebhookUrl: webhookUrl,
      fileOrganizerTable: tableName,
    };
  },
});
