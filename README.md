# File Organizer

AI-powered Telegram bot that organizes files into Google Drive using Claude for categorization, deployed on AWS Lambda with SST v3.

## How it works

```
Telegram User
     │
     │  sends file
     ▼
Telegram Bot API
     │  webhook POST
     ▼
AWS Lambda (Function URL)
     │
     ├──► Claude API          analyze filename + MIME → suggest folder path
     ├──► Google Drive API    create folders recursively, upload file
     └──► DynamoDB            store user state, OAuth tokens, custom rules
```

1. User sends a file to the Telegram bot
2. Claude analyzes the filename and MIME type and suggests a Google Drive folder path
3. Bot asks the user to confirm, edit, or cancel the suggested path
4. On confirmation, the file is uploaded to Google Drive at that path (folders are created automatically)
5. Custom rules can skip the confirmation step for files that always go to the same place

## Features

- **AI categorization** — Claude suggests a folder path based on filename and file type
- **Confirm before upload** — inline keyboard lets you approve, edit the path, or cancel
- **Custom rules** — define rules in plain English (e.g. _"always put PDFs with invoice in Work/Invoices"_); matching files skip confirmation
- **Per-user OAuth** — each user connects their own Google Drive account
- **Recursive folder creation** — nested paths like `Work/Invoices/2026` are created automatically

## Prerequisites

- [Bun](https://bun.sh) — package manager and runtime
- AWS account with CLI configured (`aws configure`)
- [SST v3](https://sst.dev) — `bun add sst` (already in `package.json`)
- Telegram bot token from [@BotFather](https://t.me/BotFather)
- Google Cloud project with OAuth 2.0 credentials (Drive API enabled)
- Anthropic API key from [console.anthropic.com](https://console.anthropic.com)

## Setup

### 1. Install dependencies

```bash
bun install
```

### 2. Create a Telegram bot

1. Open [@BotFather](https://t.me/BotFather) in Telegram
2. Send `/newbot` and follow the prompts
3. Copy the bot token

### 3. Create Google OAuth credentials

1. Go to [Google Cloud Console](https://console.cloud.google.com) → APIs & Services → Credentials
2. Enable the **Google Drive API** for your project
3. Create an **OAuth 2.0 Client ID** (type: Web application)
4. Add a placeholder redirect URI for now (e.g. `https://example.com`) — you will update this after the first deploy
5. Copy the Client ID and Client Secret

### 4. Set environment variables

```bash
export TELEGRAM_BOT_TOKEN=your_bot_token
export CLAUDE_API_KEY=your_anthropic_api_key
export GOOGLE_CLIENT_ID=your_google_client_id
export GOOGLE_CLIENT_SECRET=your_google_client_secret
export GOOGLE_REDIRECT_URI=https://placeholder.example.com   # updated after first deploy
```

Some values are stored as SST secrets in AWS SSM Parameter Store instead of local env vars:

```bash
bunx sst secret set CLAUDE_TOKEN_JSON '{"access_token":"...","refresh_token":"...","email":"...","type":"claude"}'
```

| Variable | Description |
|---|---|
| `TELEGRAM_BOT_TOKEN` | Token from BotFather |
| `CLAUDE_API_KEY` | Anthropic API key for Claude |
| `GOOGLE_CLIENT_ID` | Google OAuth 2.0 client ID |
| `GOOGLE_CLIENT_SECRET` | Google OAuth 2.0 client secret |
| `GOOGLE_REDIRECT_URI` | Lambda Function URL (set after first deploy) |
| `CLAUDE_TOKEN_JSON` | Claude OAuth token JSON from `claude login` — set via `sst secret set`, not `export` |

### 5. Deploy

```bash
bunx sst deploy
```

The deploy outputs three values:

| Output | Description |
|---|---|
| `proxyUrl` | Existing CLIProxy Lambda URL |
| `telegramWebhookUrl` | Lambda Function URL for the Telegram bot |
| `fileOrganizerTable` | DynamoDB table name |

### 6. Register the Telegram webhook

```bash
curl "https://api.telegram.org/bot<TELEGRAM_BOT_TOKEN>/setWebhook?url=<telegramWebhookUrl>"
```

### 7. Set the OAuth redirect URI and redeploy

1. Copy the `telegramWebhookUrl` from the deploy output
2. Update `GOOGLE_REDIRECT_URI` to that URL:
   ```bash
   export GOOGLE_REDIRECT_URI=https://xxxx.lambda-url.ap-southeast-1.on.aws/
   ```
3. In Google Cloud Console → Credentials → your OAuth client, add the same URL as an authorized redirect URI
4. Redeploy:
   ```bash
   bunx sst deploy
   ```

### 8. Connect Google Drive

Send `/start` to your bot in Telegram — it will send a Google authorization link. Click it, authorize, and you're ready to go.

## Bot commands

| Command | Description |
|---|---|
| `/start` | Connect your Google Drive account via OAuth |
| `/rules` | List your current custom organization rules |
| `/addrule` | Add a new rule in plain English |
| `/delrule <id>` | Delete a rule by its ID prefix (shown in `/rules`) |
| _(send any file)_ | Analyze and organize the file into Google Drive |

## Project structure

```
sst.config.ts                                  — SST app config
src/packages/file_organizer/
├── stack.ts                                   — Pulumi infra: DynamoDB, IAM, Lambda, Function URL
├── handler.ts                                 — Lambda entry point; routes Telegram messages and callbacks
├── telegram.ts                                — Telegram Bot API client (send, download, keyboards)
├── claude.ts                                  — Claude API: file categorization and rule parsing
├── google-drive.ts                            — Google Drive: OAuth, folder creation, file upload
├── rules.ts                                   — DynamoDB: user state, OAuth tokens, custom rules
└── types.ts                                   — Shared TypeScript interfaces
src/packages/cli_proxy_api_serverless/
├── stack.ts                                   — Pulumi infra for the CLIProxy Lambda
└── docker/                                    — CLIProxy container
    ├── Dockerfile
    ├── config.yaml
    └── entrypoint.sh
```

### DynamoDB single-table schema

| PK | SK | Contents |
|---|---|---|
| `USER#<userId>` | `STATE` | Current conversation state (idle / awaiting confirmation / etc.) |
| `USER#<userId>` | `OAUTH` | Google OAuth refresh token and access token |
| `USER#<userId>` | `RULE#<ruleId>` | A custom organization rule |

## Development notes

- **Lambda bundling** — `stack.ts` uses a raw `FileArchive` pointing at `src/`. For production deployments with large dependency trees, replace this with an esbuild bundle step (e.g. `esbuild --bundle --platform=node --target=node22`).
- **Pending state TTL** — DynamoDB TTL is set to 30 minutes on `STATE` items, so stale confirmations expire automatically.
- **Telegram file size limit** — Telegram bots can download files up to 20 MB via the Bot API. Files larger than this need the Telegram client API (MTProto), which is out of scope here.
- **GOOGLE_REDIRECT_URI chicken-and-egg** — the redirect URI must match the Lambda URL exactly. Deploy once with a placeholder, then update and redeploy with the real URL.
