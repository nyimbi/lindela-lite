FROM node:20-bookworm-slim

WORKDIR /app

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl \
  && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY src ./src
COPY public ./public
COPY docs ./docs
COPY examples ./examples
COPY scripts ./scripts
COPY README.md LICENSE ./

ENV NODE_ENV=production
ENV LINDELA_LITE_PORT=4177
EXPOSE 4177

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=5 \
  CMD curl -fsS "http://127.0.0.1:${LINDELA_LITE_PORT}/api/v1/health" >/dev/null || exit 1

CMD ["npm", "start"]
