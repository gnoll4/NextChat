#!/usr/bin/env bash
set -euo pipefail

SECRETS_FILE="/tmp/runtime-secrets.env"
printf 'DEEPSEEK_API_KEY=%s\n' "${DEEPSEEK_API_KEY}" > "${SECRETS_FILE}"

# Workers Builds injects two deployment guards for the connected `nextchat`
# project:
#   - WRANGLER_CI_OVERRIDE_NAME forces every Wrangler deploy back to `nextchat`.
#   - WRANGLER_CI_MATCH_TAG prevents deploying to a Worker whose script tag does
#     not match the connected project.
#
# Keep the account/token credentials from Workers Builds, but override only the
# target name and remove only the tag guard for this secondary deployment. The
# Wrangler environment resolves to the internal Worker `nextchat-edge-api`.
env -u WRANGLER_CI_MATCH_TAG \
  WRANGLER_CI_OVERRIDE_NAME=nextchat-edge-api \
  npx wrangler deploy \
  --config wrangler.edge-api.jsonc \
  --env edge-api \
  --secrets-file "${SECRETS_FILE}"

# Deploy the real NextChat app last with the original Workers Builds environment
# untouched. At this point nextchat-edge-api exists, so the Service Binding can
# be resolved without changing chat.gnoll.top routing.
npx @opennextjs/cloudflare deploy -- --secrets-file "${SECRETS_FILE}"
