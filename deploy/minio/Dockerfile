# MeetSum's own MinIO image (M10, risk R16; user decision: build from the
# official source, no third-party image).
#
# MinIO stopped publishing community images in late 2025, so this builds the
# server and `mc` from github.com/minio/minio and github.com/minio/mc at their
# last official release tags. The tag AND its commit are pinned; the build
# fails if a tag was ever moved. Both base images are pinned by digest
# (tests/image-pins.test.ts).
#
# Runtime layout matches the previous image (MinIO's own Dockerfile): runs as
# root, data in /data, `minio` and `mc` in /usr/bin, so the existing
# minio-data volume and the `mc ready local` healthcheck are unchanged.
#
#   docker compose build minio          # docker-compose.yml / .prod.yml
#   docker build -t meetsum-minio:RELEASE.2025-10-15T17-29-55Z deploy/minio
#
# Updating: change the four release/commit ARGs (verify with
# `git ls-remote --tags https://github.com/minio/minio <tag>` and the same for
# minio/mc; an annotated tag lists its commit on the `^{}` line), rebuild, and
# record the new tag in docs/runbooks/deploy.md ("Images").

# Go: the current release line. MinIO's go.mod asks for go1.24+; Go's
# compatibility promise covers newer toolchains. If a future bump fails to
# compile, fall back to golang:1.24.13-alpine3.22@sha256:3641e0d9b931dc4f2f185dcd669c4679670e9277c8166a838ddb98a2d4389cb5
# (the toolchain line MinIO itself built this release with).
FROM golang:1.26.9-alpine@sha256:3082400e369fa24d5fc60bca20edab3f6d604e0c5a690ec66b295eff4dd87ade AS build

ARG MINIO_RELEASE=RELEASE.2025-10-15T17-29-55Z
ARG MINIO_COMMIT=9e49d5e7a648f00e26f2246f4dc28e6b07f8c84a
ARG MC_RELEASE=RELEASE.2025-08-13T08-35-41Z
ARG MC_COMMIT=7394ce0dd2a80935aded936b09fa12cbb3cb8096

ENV CGO_ENABLED=0 \
    GOTOOLCHAIN=local \
    GOFLAGS=-trimpath

RUN apk add --no-cache git ca-certificates

# "RELEASE.2025-10-15T17-29-55Z" -> "2025-10-15T17:29:55Z", the version
# argument upstream's Makefile passes to buildscripts/gen-ldflags.go.
WORKDIR /src/minio
RUN git clone --depth 1 --branch "${MINIO_RELEASE}" https://github.com/minio/minio.git . \
 && test "$(git rev-parse HEAD)" = "${MINIO_COMMIT}" \
 && version="$(echo "${MINIO_RELEASE#RELEASE.}" | sed -E 's/T([0-9]{2})-([0-9]{2})-([0-9]{2})Z$/T\1:\2:\3Z/')" \
 && ldflags="$(MINIO_RELEASE=RELEASE go run buildscripts/gen-ldflags.go "${version}")" \
 && go build -tags kqueue -ldflags "${ldflags}" -o /out/minio . \
 && cp LICENSE /out/LICENSE.minio && cp CREDITS /out/CREDITS.minio

WORKDIR /src/mc
RUN git clone --depth 1 --branch "${MC_RELEASE}" https://github.com/minio/mc.git . \
 && test "$(git rev-parse HEAD)" = "${MC_COMMIT}" \
 && version="$(echo "${MC_RELEASE#RELEASE.}" | sed -E 's/T([0-9]{2})-([0-9]{2})-([0-9]{2})Z$/T\1:\2:\3Z/')" \
 && ldflags="$(MC_RELEASE=RELEASE go run buildscripts/gen-ldflags.go "${version}")" \
 && go build -tags kqueue -ldflags "${ldflags}" -o /out/mc . \
 && cp LICENSE /out/LICENSE.mc && cp CREDITS /out/CREDITS.mc

RUN /out/minio --version && /out/mc --version

FROM alpine:3.22.6@sha256:5291449c3df73caf6ed85e649dec1b9e818b39a5d8c871e97afc13e9cd5e8fa8

ARG MINIO_RELEASE=RELEASE.2025-10-15T17-29-55Z
ARG MC_RELEASE=RELEASE.2025-08-13T08-35-41Z

LABEL org.opencontainers.image.title="meetsum-minio" \
      org.opencontainers.image.description="MinIO server and mc built from the official source for MeetSum" \
      org.opencontainers.image.source="https://github.com/minio/minio" \
      org.opencontainers.image.version="${MINIO_RELEASE}" \
      org.opencontainers.image.licenses="AGPL-3.0-only" \
      io.meetsum.minio.release="${MINIO_RELEASE}" \
      io.meetsum.mc.release="${MC_RELEASE}"

# ca-certificates: TLS to remote targets (replication, mc aliases).
RUN apk add --no-cache ca-certificates

COPY --from=build /out/minio /out/mc /usr/bin/
COPY --from=build /out/LICENSE.minio /out/CREDITS.minio /out/LICENSE.mc /out/CREDITS.mc /licenses/

# mc keeps its alias config here (the healthcheck runs `mc ready local`).
ENV MC_CONFIG_DIR=/tmp/.mc

EXPOSE 9000 9001
VOLUME ["/data"]

ENTRYPOINT ["/usr/bin/minio"]
CMD ["server", "/data", "--console-address", ":9001"]
