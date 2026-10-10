# VUL-06. Pinned by digest, not tag. `node:20-bookworm-slim` is a mutable tag: a
# rebuild can pull a different base than the one the SBOM and the SLSA
# provenance attest, so the attestation describes bytes the image no longer
# contains. The tag is kept in the comment because a digest alone is unreadable
# and someone has to know what to update.
#
# To move it: resolve the new digest for the tag and change both lines.
#   TOKEN=$(curl -s "https://auth.docker.io/token?service=registry.docker.io&scope=repository:library/node:pull" | jq -r .token)
#   curl -sI -H "Authorization: Bearer $TOKEN" \
#     -H "Accept: application/vnd.oci.image.index.v1+json" \
#     "https://registry-1.docker.io/v2/library/node/manifests/20-bookworm-slim" \
#     | grep -i docker-content-digest
FROM node:20-bookworm-slim@sha256:2cf067cfed83d5ea958367df9f966191a942351a2df77d6f0193e162b5febfc0

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
# Must be 0.0.0.0 here: a container bound to 127.0.0.1 is unreachable through
# a published port. Set on the image, not only in compose, so `docker run -p`
# without a compose file behaves the same.
ENV LINDELA_LITE_HOST=0.0.0.0
EXPOSE 4177

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=5 \
  CMD curl -fsS "http://127.0.0.1:${LINDELA_LITE_PORT}/api/v1/health" >/dev/null || exit 1

CMD ["npm", "start"]
