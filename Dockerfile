# syntax=docker/dockerfile:1.7

# Container image for opensac.
#
# The binary is compiled from this repository with the same `scripts/build.ts`
# the npm packages use, and the release target is resolved through the shared
# platform table, so an image and an npm install of one tag report the same
# version and can never be built for a platform the packages do not publish.
#
# The entry point is the shared Core host (`opensac core`): an image has no
# terminal for the Ink TUI, so the container exposes the Core HTTP API and the
# user mounts the workspace they want the agent to work in.

ARG DENO_VERSION=2.9.7
ARG VERSION=unknown

FROM denoland/deno:alpine-${DENO_VERSION} AS builder
WORKDIR /src
ARG TARGETARCH
ARG VERSION
# Deno's dependency graph changes far less often than the sources, so caching it
# behind its own layer keeps most source edits from re-resolving the world.
# The layer deliberately copies no source: caching an entry point needs that
# entry point's whole relative import graph to be present, so a partial copy
# fails to resolve, and copying the sources would invalidate this layer on every
# edit. `deno install` resolves the whole dependency closure from deno.json and
# deno.lock alone, which is exactly the layer boundary wanted here.
COPY deno.json deno.lock ./
RUN deno install --frozen-lockfile
COPY . .
# The build context has no .git, and a build reads the product version from the
# newest v* tag, so the tag the release was cut from is passed explicitly. The
# release target is resolved through the same platform table the npm packages
# are generated from, rather than a second list written here.
RUN set -eux; \
    eval "$(deno eval --quiet 'import { findPlatform, npmPlatformFor } from "./scripts/platforms.ts"; const t = findPlatform(npmPlatformFor("linux", Deno.env.get("TARGETARCH") ?? "")); if (t === undefined) Deno.exit(1); console.log(`platform=${t.npmPlatform} binary=${t.binary}`);')"; \
    test -n "${platform}" -a -n "${binary}"; \
    deno run -A scripts/build.ts --build-version="${VERSION}" --target="${platform}"; \
    mkdir -p /out; \
    cp "bin/${binary}" /out/opensac; \
    chmod 0755 /out/opensac

# The Core binds 127.0.0.1 by default, which nothing outside the container can
# reach, so the image ships a settings.json that listens on every interface.
# There is no auth by default; a deployment is expected to set a password in
# its own settings or terminate TLS in front of the port.
FROM builder AS seed
RUN mkdir -p /opensac \
    && printf '%s\n' '{"core":{"host":"0.0.0.0","port":4096}}' > /opensac/settings.json

FROM ubuntu:24.04 AS runtime-ubuntu
ARG VERSION=unknown
LABEL org.opencontainers.image.source="https://github.com/startvibecoding/opensac" \
	org.opencontainers.image.title="OpenSAC" \
	org.opencontainers.image.description="OpenSAC terminal AI coding assistant" \
	org.opencontainers.image.licenses="MIT" \
	org.opencontainers.image.version="${VERSION}" \
	org.opencontainers.image.base.name="ubuntu:24.04"
RUN apt-get update \
	&& apt-get install -y --no-install-recommends \
		bash ca-certificates curl git less openssh-client ripgrep tzdata \
	&& rm -rf /var/lib/apt/lists/*
ENV OPENSAC_DIR=/opensac \
	OPENSAC_BUILD_VERSION=${VERSION}
COPY --from=seed /opensac/settings.json /opensac/settings.json
COPY --from=builder /out/opensac /usr/local/bin/opensac
WORKDIR /workspace
EXPOSE 4096
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
	CMD ["opensac", "core", "status"]
USER root
ENTRYPOINT ["opensac", "core"]

FROM debian:bookworm-slim AS runtime-debian
ARG VERSION=unknown
LABEL org.opencontainers.image.source="https://github.com/startvibecoding/opensac" \
	org.opencontainers.image.title="OpenSAC" \
	org.opencontainers.image.description="OpenSAC terminal AI coding assistant" \
	org.opencontainers.image.licenses="MIT" \
	org.opencontainers.image.version="${VERSION}" \
	org.opencontainers.image.base.name="debian:bookworm-slim"
RUN apt-get update \
	&& apt-get install -y --no-install-recommends \
		bash ca-certificates curl git less openssh-client ripgrep tzdata \
	&& rm -rf /var/lib/apt/lists/*
ENV OPENSAC_DIR=/opensac \
	OPENSAC_BUILD_VERSION=${VERSION}
COPY --from=seed /opensac/settings.json /opensac/settings.json
COPY --from=builder /out/opensac /usr/local/bin/opensac
WORKDIR /workspace
EXPOSE 4096
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
	CMD ["opensac", "core", "status"]
USER root
ENTRYPOINT ["opensac", "core"]

# Deno publishes no musl target in scripts/platforms.ts, so this image runs the
# same glibc binary as the other two and bridges it with gcompat rather than
# publishing a fourth, npm-invisible platform.
FROM alpine:3.21 AS runtime-alpine
ARG VERSION=unknown
LABEL org.opencontainers.image.source="https://github.com/startvibecoding/opensac" \
	org.opencontainers.image.title="OpenSAC" \
	org.opencontainers.image.description="OpenSAC terminal AI coding assistant" \
	org.opencontainers.image.licenses="MIT" \
	org.opencontainers.image.version="${VERSION}" \
	org.opencontainers.image.base.name="alpine:3.21"
RUN apk add --no-cache \
	bash ca-certificates curl git less libstdc++ openssh-client ripgrep tzdata \
	gcompat
ENV OPENSAC_DIR=/opensac \
	OPENSAC_BUILD_VERSION=${VERSION}
COPY --from=seed /opensac/settings.json /opensac/settings.json
COPY --from=builder /out/opensac /usr/local/bin/opensac
WORKDIR /workspace
EXPOSE 4096
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
	CMD ["opensac", "core", "status"]
USER root
ENTRYPOINT ["opensac", "core"]
