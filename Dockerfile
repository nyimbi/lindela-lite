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

# A non-root runtime, with a uid in the same range node images already use for
# `node`. The app needs one writable path and one only: the JSON store defaults
# to data/ and the calibration artefacts go beside it, so that directory is
# created and owned rather than the whole image being made writable.
RUN groupadd --system --gid 1001 lindela \
  && useradd --system --uid 1001 --gid lindela --home-dir /app --shell /usr/sbin/nologin lindela \
  && mkdir -p /app/data \
  && chown -R lindela:lindela /app/data
USER lindela

ENV NODE_ENV=production
ENV LINDELA_LITE_PORT=4177
EXPOSE 4177

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=5 \
  CMD curl -fsS "http://127.0.0.1:${LINDELA_LITE_PORT}/api/v1/health" >/dev/null || exit 1

CMD ["npm", "start"]
