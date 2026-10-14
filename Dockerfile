# Base image pinned by tag and digest (M10 B5; resolved 2026-10-14 with the
# registry API). Dependabot (.github/dependabot.yml) proposes bumps;
# tests/image-pins.test.ts fails on any FROM without @sha256.
FROM node:24.21.0-alpine@sha256:ebfe2f90462722a7a4de65e91990e97fe0d401c70e0e762c5b53302f905ec1c1 AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

FROM node:24.21.0-alpine@sha256:ebfe2f90462722a7a4de65e91990e97fe0d401c70e0e762c5b53302f905ec1c1 AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
# next build's TypeScript pass exceeds V8's default ~2 GB old-space cap on this
# release, OOM-ing on the memory-constrained VPS. Give the build more heap.
ENV NODE_OPTIONS="--max-old-space-size=4096"
RUN npm run build

FROM node:24.21.0-alpine@sha256:ebfe2f90462722a7a4de65e91990e97fe0d401c70e0e762c5b53302f905ec1c1 AS runner
WORKDIR /app
ENV NODE_ENV=production
# The git SHA of this build (scripts/deploy-vps.sh passes it): the Sentry
# release and the image label deploy/rollback read back.
ARG MEETSUM_GIT_SHA=""
ENV MEETSUM_GIT_SHA=${MEETSUM_GIT_SHA}
LABEL org.opencontainers.image.revision=${MEETSUM_GIT_SHA}
RUN apk add --no-cache ffmpeg
COPY --from=builder /app/package.json ./package.json
COPY --from=builder /app/package-lock.json ./package-lock.json
COPY --from=builder /app/.next ./.next
COPY --from=builder /app/public ./public
# Vendored IBM Plex TTFs for the PDF export (lib/pdf/fonts.ts); next build does not trace them.
COPY --from=builder /app/assets ./assets
COPY --from=builder /app/bin ./bin
COPY --from=builder /app/db ./db
COPY --from=builder /app/lib ./lib
COPY --from=builder /app/mcp ./mcp
COPY --from=builder /app/scripts ./scripts
COPY --from=builder /app/worker ./worker
COPY --from=builder /app/tsconfig.json ./tsconfig.json
COPY --from=builder /app/node_modules ./node_modules
EXPOSE 3000
CMD ["npm", "run", "start"]
