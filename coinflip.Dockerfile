# COINFLIP on one server: the page, a stateless DIA fixing oracle, a desk, and a
# settler, all from `pnpm demo -- --server`. Only the page port is exposed; the
# services talk to each other on loopback inside the container.
#
#   docker build -f coinflip.Dockerfile -t coinflip .
#   docker run -p 4173:4173 --mount source=coinflip-data,target=/data coinflip
#
# Railway reads railway.toml, which points here. Mount persistent storage at
# /data and route the domain to port 4173. See README.md and
# docs/mainnet-runbook.md.
#
# /data holds the oracle sample/fixing log, the desk's quote book and wallet DB,
# and the settler's progress (plus auto-generated keys on Mutinynet). Keep that
# storage across deploys.
FROM node:22-alpine
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml ./
RUN CI=1 COREPACK_ENABLE_DOWNLOAD_PROMPT=0 pnpm install --frozen-lockfile
COPY . .
# The host mounts /data. Railway's validator rejects the Dockerfile keyword for it,
# and even the word in a comment, so it is not spelled out here.
ENV COINFLIP_DEMO_DIR=/data PAGE_PORT=4173
EXPOSE 4173
HEALTHCHECK --start-period=60s CMD wget -q -O /dev/null http://127.0.0.1:4173/demo.json || exit 1
CMD ["node", "scripts/demo.mjs", "--server"]
