#!/bin/sh
set -e

mkdir -p /tmp/.cli-proxy-api

if [ -n "$CLAUDE_TOKEN_JSON" ]; then
  printf '%s' "$CLAUDE_TOKEN_JSON" > /tmp/.cli-proxy-api/claude.json
fi

exec ./CLIProxyAPI
