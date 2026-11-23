FROM node:22-alpine
WORKDIR /src
RUN apk add --no-cache git
ADD https://api.github.com/repos/brg444/coinflip/commits/main /tmp/main.json
RUN git clone --depth 1 --branch main https://github.com/brg444/coinflip.git . \
 && git rev-parse HEAD > /etc/git-commit \
 && rm -rf .git \
 && corepack enable \
 && CI=1 COREPACK_ENABLE_DOWNLOAD_PROMPT=0 pnpm install --frozen-lockfile --prod
ENV DATA_DIR=/data
VOLUME /data
EXPOSE 8788
# required: BEACON_TXID — oracle identity-asset txid (64 hex, display byte order)
# optional: BEACON_GIDX — identity-asset vout, integer 0-65535, default 0
HEALTHCHECK CMD node -e "fetch('http://127.0.0.1:8788/status').then((res)=>process.exit(res.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "--experimental-strip-types", "--experimental-eventsource", "desk/main.ts"]
