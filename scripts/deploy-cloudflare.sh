#!/usr/bin/env bash
set -euo pipefail

SECRETS_FILE="/tmp/runtime-secrets.env"
printf 'DEEPSEEK_API_KEY=%s\n' "${DEEPSEEK_API_KEY}" > "${SECRETS_FILE}"

# Workers Builds injects WRANGLER_CI_OVERRIDE_NAME for the connected `nextchat`
# project. If it reaches this command, Wrangler forcibly renames this secondary
# deployment back to `nextchat`, so `nextchat-edge-api` is never created and the
# main Worker's Service Binding fails with code 10143. Remove that override only
# for the secondary Worker deployment; the main OpenNext deploy keeps the normal
# CI environment unchanged.
env -u WRANGLER_CI_OVERRIDE_NAME npx wrangler deploy \
  --config wrangler.edge-api.jsonc \
  --name nextchat-edge-api \
  --secrets-file "${SECRETS_FILE}"

# Deploy the real NextChat app last. At this point nextchat-edge-api exists, so
# the NEXTCHAT_EDGE_API Service Binding in wrangler.jsonc can be resolved.
npx @opennextjs/cloudflare deploy -- --secrets-file "${SECRETS_FILE}"
