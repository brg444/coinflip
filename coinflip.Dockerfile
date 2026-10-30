# COINFLIP on one server: the page, an oracle with its own beacon, a desk and a
# settler, all from `pnpm demo -- --server`. Only the page port is exposed; the
# services talk to each other on loopback inside the container.
#
#   docker build -f coinflip.Dockerfile -t coinflip .
#   docker run -p 4173:4173 --mount source=coinflip-data,target=/data coinflip
#
# Railway reads railway.toml, which points here. Dokploy: Build Type Dockerfile,
# Docker File `coinflip.Dockerfile`, Docker Context Path `.`. Either way, mount
# persistent storage at /data and route the domain to port 4173. The README's
# Deploy section has the steps.
#
# /data holds the keys, the beacon, the desk's book and the settler's progress.
# Keep that storage: a fresh /data starts a new beacon and a new, unfunded desk.
FROM node:22-alpine
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml ./
COPY vendor vendor
RUN CI=1 COREPACK_ENABLE_DOWNLOAD_PROMPT=0 pnpm install --frozen-lockfile
COPY . .
# The host mounts /data. Railway's validator rejects the Dockerfile keyword for it,
# and even the word in a comment, so it is not spelled out here.
ENV COINFLIP_DEMO_DIR=/data PAGE_PORT=4173
EXPOSE 4173
HEALTHCHECK --start-period=60s CMD wget -q -O /dev/null http://127.0.0.1:4173/demo.json || exit 1
CMD ["node", "scripts/demo.mjs", "--server"]
