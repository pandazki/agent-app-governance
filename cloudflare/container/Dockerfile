# The Host's container for the Cloudflare edition. Build context: the repository's root (the installer sets it),
# so that the shared Host code in host/ and this edition's files in cloudflare/ both reach the image; the root's
# .dockerignore keeps everything else out.
#
# Node 24 runs the supervisor and the apps' own `npm ci && npm test`; Bun runs the Host, because pneuma-framework
# ships TypeScript source for Bun. This image is built for linux/amd64 on any machine, under emulation on an arm64
# Mac, so nothing here runs Bun at build time.
FROM node:24-bookworm-slim

# pneuma-framework, at the commit local/compose.yaml pins (the installer reads it there and passes it in).
ARG FRAMEWORK_COMMIT
ARG BUN_VERSION=1.4.5

RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates && rm -rf /var/lib/apt/lists/*

# Bun's linux-x64 binary from its npm package (no install script runs). Bun does not run under amd64 emulation on an
# arm64 Mac (neither this build nor the baseline one), so the image is tried on Cloudflare, not locally.
ADD https://registry.npmjs.org/@oven/bun-linux-x64/-/bun-linux-x64-${BUN_VERSION}.tgz /tmp/bun.tgz
RUN tar -xzf /tmp/bun.tgz -C /tmp && install -m 0755 /tmp/package/bin/bun /usr/local/bin/bun && rm -rf /tmp/package /tmp/bun.tgz

# The two framework packages the Host imports, linked where /opt/appgov's code resolves them; the Host imports only
# their dependency-free modules, as in the local edition's image.
ADD https://github.com/pandazki/pneuma-framework/archive/${FRAMEWORK_COMMIT}.tar.gz /tmp/framework.tgz
RUN test -n "$FRAMEWORK_COMMIT" \
 && mkdir -p /opt/appgov/framework /opt/appgov/node_modules/@pneuma-framework \
 && tar -xzf /tmp/framework.tgz -C /opt/appgov/framework --strip-components 1 && rm /tmp/framework.tgz \
 && for p in core host-kit; do ln -s /opt/appgov/framework/packages/$p /opt/appgov/node_modules/@pneuma-framework/$p; done

# Two users: the Host runs as `host`, the apps' tests as `tests`. The Host's directories are closed to `tests`;
# /work, where the supervisor runs each test in a directory of its own, can be passed through but not listed.
RUN groupadd --system --gid 10001 host && useradd --system --uid 10001 --gid host --home-dir /home/host --create-home host \
 && groupadd --gid 10002 tests && useradd --uid 10002 --gid tests --home-dir /home/tests --create-home tests \
 && mkdir -p /data/apps /work /run/appgov \
 && chown -R host:host /data && chmod 700 /data /home/host && chmod 711 /work

COPY host/src /opt/appgov/host/src
COPY cloudflare/src /opt/appgov/cloudflare/src
COPY cloudflare/bin /opt/appgov/cloudflare/bin
COPY cloudflare/overlay /opt/appgov/cloudflare/overlay
COPY cloudflare/template /opt/appgov/cloudflare/template
COPY cloudflare/policy /opt/appgov/cloudflare/policy
COPY cloudflare/container/supervisor.mjs /opt/appgov/cloudflare/container/supervisor.mjs

ENV APPGOV_APPS_DIR=/data/apps APPGOV_HOST_PORT=8080
EXPOSE 8080
CMD ["node", "/opt/appgov/cloudflare/container/supervisor.mjs"]
