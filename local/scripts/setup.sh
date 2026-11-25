#!/bin/sh
# Fetches pneuma-framework's source at the commit compose.yaml pins into vendor/pneuma-framework
# (git-ignored), then installs this directory's dependencies from bun.lock. Run it as `bun run setup`:
# once after cloning, and again whenever the pin in compose.yaml moves. The tests, the typecheck and
# the host-driven Host need it; `docker compose up` does not, because the image build fetches the
# same commit itself.
set -eu
cd "$(dirname "$0")/.."

line=$(grep -m1 '^x-framework-context:' compose.yaml) || {
  echo "setup: compose.yaml has no x-framework-context line" >&2
  exit 1
}
url=$(printf '%s\n' "$line" | sed -n 's|.*\(https://[^#"]*\)#\([0-9a-f]\{40\}\).*|\1|p')
pin=$(printf '%s\n' "$line" | sed -n 's|.*\(https://[^#"]*\)#\([0-9a-f]\{40\}\).*|\2|p')
if [ -z "$url" ] || [ -z "$pin" ]; then
  echo "setup: could not read a repository URL and a 40-character commit from: $line" >&2
  exit 1
fi

dir=vendor/pneuma-framework
if [ ! -d "$dir/.git" ]; then
  mkdir -p "$dir"
  git -C "$dir" init -q
  git -C "$dir" remote add origin "$url"
fi
git -C "$dir" remote set-url origin "$url"
if [ "$(git -C "$dir" rev-parse -q --verify 'HEAD^{commit}' 2>/dev/null || true)" != "$pin" ]; then
  echo "setup: fetching pneuma-framework $pin from $url"
  git -C "$dir" fetch -q --depth 1 origin "$pin"
  git -C "$dir" checkout -q --detach "$pin"
fi
echo "setup: pneuma-framework is at $(git -C "$dir" rev-parse --short HEAD) in $dir"

bun install --frozen-lockfile
