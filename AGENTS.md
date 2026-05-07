# AGENTS.md

## Runtime
- Bun local dev, Node 24.x on Lambda (ARM64)
- SST 4.x (README says v3 — wrong, use 4.x APIs)
- No tests. Verify manually via Telegram.
- tsconfig.json is empty — Bun TS defaults.

## Gotchas
- Lambda URL serves both POST (Telegram webhook) AND GET (OAuth redirect).
  handler.ts checks `queryStringParameters` to route OAuth GET requests.
- GOOGLE_REDIRECT_URI must match deployed Lambda URL. Needs two deploys:
  first with placeholder, second with real URL after Lambda URL is known.
- Always return HTTP 200 to Telegram — non-200 triggers retry.
- Dynamic import `node:stream` at call site in google-drive.ts (Lambda ESM compat).
- Pending state TTL is 30 min on DynamoDB. Expired states silently revert to idle.

## Code Style
- Biome: single quotes, space indent, organize imports on
- Section comments: `// ─── Something ──────` (keep when editing near them)
- Error pattern: console.error/warn, don't re-throw to caller (Telegram retry risk)
- SST secrets: never hardcode credentials, use `new sst.Secret('NAME')`

## DynamoDB
- Single table: PK=`USER#<userId>`, SK=`STATE | OAUTH | RULE#<ruleId>`
- Table name resolved via `Resource.FileOrganizerTable.name` from `sst`
- Use `@aws-sdk/util-dynamodb` marshall/unmarshall, not raw DynamoDB JSON
