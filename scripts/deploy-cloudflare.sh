#!/usr/bin/env bash
set -euo pipefail

SECRETS_FILE="/tmp/runtime-secrets.env"
printf 'DEEPSEEK_API_KEY=%s\n' "${DEEPSEEK_API_KEY}" > "${SECRETS_FILE}"

# Deploy the connected NextChat Worker first. This can refresh the Custom Domain
# without leaving it as the final owner of the more-specific DeepSeek API path.
npx @opennextjs/cloudflare deploy -- --secrets-file "${SECRETS_FILE}"

# Deploy the lightweight DeepSeek proxy last so it owns the more-specific
# chat.gnoll.top/api/deepseek/* route. The main Worker keeps its Service Binding
# fallback, but normal chat traffic now bypasses the large OpenNext isolate.
env -u WRANGLER_CI_MATCH_TAG \
  WRANGLER_CI_OVERRIDE_NAME=nextchat-edge-api \
  npx wrangler deploy \
  --config wrangler.edge-api.jsonc \
  --env edge-api \
  --secrets-file "${SECRETS_FILE}"
