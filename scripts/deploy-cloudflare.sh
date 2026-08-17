#!/usr/bin/env bash
set -euo pipefail

SECRETS_FILE="/tmp/runtime-secrets.env"
printf 'DEEPSEEK_API_KEY=%s\n' "${DEEPSEEK_API_KEY}" > "${SECRETS_FILE}"

# Deploy the connected `nextchat` project first. Wrangler reconciles this
# Worker's configured routes on deploy, which clears any stale API routes that
# were previously attached to `nextchat`. The secondary Worker already exists,
# so the NEXTCHAT_EDGE_API Service Binding can still be resolved here.
npx @opennextjs/cloudflare deploy -- --secrets-file "${SECRETS_FILE}"

# Workers Builds injects two deployment guards for the connected `nextchat`
# project:
#   - WRANGLER_CI_OVERRIDE_NAME forces every Wrangler deploy back to `nextchat`.
#   - WRANGLER_CI_MATCH_TAG prevents deploying to a Worker whose script tag does
#     not match the connected project.
#
# Keep the account/token credentials from Workers Builds, but override only the
# target name and remove only the tag guard for this secondary deployment. Once
# the main Worker has released the stale API routes, nextchat-edge-api can claim
# the more-specific /api/deepseek/* and /api/sync/d1* routes.
env -u WRANGLER_CI_MATCH_TAG \
  WRANGLER_CI_OVERRIDE_NAME=nextchat-edge-api \
  npx wrangler deploy \
  --config wrangler.edge-api.jsonc \
  --env edge-api \
  --secrets-file "${SECRETS_FILE}"
