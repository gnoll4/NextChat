#!/usr/bin/env bash
set -euo pipefail

SECRETS_FILE="/tmp/runtime-secrets.env"
printf 'DEEPSEEK_API_KEY=%s\n' "${DEEPSEEK_API_KEY}" > "${SECRETS_FILE}"

# Workers Builds requires the top-level Wrangler name to match the connected
# project (`nextchat`). Deploy the isolated API Worker as a Wrangler Environment
# instead; `--env edge-api` creates/updates the real Worker `nextchat-edge-api`
# while still satisfying the connected-build name check.
npx wrangler deploy \
  --config wrangler.edge-api.jsonc \
  --env edge-api \
  --secrets-file "${SECRETS_FILE}"

# Deploy the real NextChat app last. At this point nextchat-edge-api exists, so
# the NEXTCHAT_EDGE_API Service Binding in wrangler.jsonc can be resolved.
npx @opennextjs/cloudflare deploy -- --secrets-file "${SECRETS_FILE}"
