#!/bin/sh
# Prepares this directory for its tests and typecheck: the local edition's setup fetches pneuma-framework at the
# commit local/compose.yaml pins and links it where the shared Host code in ../host resolves it; then this
# directory's own dependencies (wrangler, TypeScript) install from package-lock.json. Run it as `npm run setup`.
set -eu
cd "$(dirname "$0")/.."
(cd ../local && sh scripts/setup.sh)
npm ci --no-audit --no-fund
