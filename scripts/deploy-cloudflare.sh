#!/usr/bin/env bash
set -euo pipefail

SECRETS_FILE="/tmp/runtime-secrets.env"
printf 'DEEPSEEK_API_KEY=%s\n' "${DEEPSEEK_API_KEY}" > "${SECRETS_FILE}"

# First neutralize the previously-created dedicated API Worker so any stale
# path Routes or accidental domain ownership are removed before the main app
# is deployed. It remains deployed with no public route and workers.dev off.
npx wrangler deploy \
  --config wrangler.edge-api.jsonc \
  --name nextchat-edge-api \
  --secrets-file "${SECRETS_FILE}"

# Deploy the real NextChat app last. wrangler.jsonc is the routing source of
# truth: workers.dev stays enabled and chat.gnoll.top is the Custom Domain.
npx @opennextjs/cloudflare deploy -- --secrets-file "${SECRETS_FILE}"
