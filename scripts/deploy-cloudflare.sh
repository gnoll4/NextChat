#!/usr/bin/env bash
set -euo pipefail

SECRETS_FILE="/tmp/runtime-secrets.env"
printf 'DEEPSEEK_API_KEY=%s\n' "${DEEPSEEK_API_KEY}" > "${SECRETS_FILE}"

# Deploy the main OpenNext application first.
npx @opennextjs/cloudflare deploy -- --secrets-file "${SECRETS_FILE}"

# Deploy the tiny dedicated API Worker afterwards. Its more-specific Routes
# take precedence over the chat.gnoll.top Custom Domain Worker, so long
# DeepSeek requests never load the OpenNext module graph.
npx wrangler deploy \
  --config wrangler.edge-api.jsonc \
  --secrets-file "${SECRETS_FILE}"
