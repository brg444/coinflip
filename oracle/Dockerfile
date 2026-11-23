FROM node:22-alpine
WORKDIR /app
RUN apk add --no-cache git
ADD https://api.github.com/repos/brg444/coinflip/commits/main /tmp/main.json
RUN git clone --depth 1 --branch main https://github.com/brg444/coinflip.git /tmp/src \
 && cp -a /tmp/src/. /app/ \
 && rm -rf /tmp/src /app/.git \
 && corepack enable \
 && CI=1 COREPACK_ENABLE_DOWNLOAD_PROMPT=0 pnpm install --frozen-lockfile \
 && pnpm oracle:page
ENV DATA_DIR=/data HOST=0.0.0.0
VOLUME /data
EXPOSE 8789
HEALTHCHECK CMD node -e "fetch('http://127.0.0.1:8789/api/status').then((res)=>process.exit(res.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "--experimental-strip-types", "--experimental-eventsource", "oracle/main.ts"]
