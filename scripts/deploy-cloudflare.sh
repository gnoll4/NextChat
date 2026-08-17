#!/usr/bin/env bash
set -euo pipefail

SECRETS_FILE="/tmp/runtime-secrets.env"
printf 'DEEPSEEK_API_KEY=%s\n' "${DEEPSEEK_API_KEY}" > "${SECRETS_FILE}"

# Deploy the main OpenNext application first. wrangler.jsonc explicitly keeps
# the nextchat workers.dev hostname enabled as a fallback entry point.
npx @opennextjs/cloudflare deploy -- --secrets-file "${SECRETS_FILE}"

# Deploy the tiny dedicated API Worker afterwards. Pin the service name on the
# CLI as well as in wrangler.edge-api.jsonc so its Routes can never be attached
# to the main nextchat Worker by an unexpected config-resolution path.
npx wrangler deploy \
  --config wrangler.edge-api.jsonc \
  --name nextchat-edge-api \
  --secrets-file "${SECRETS_FILE}"
