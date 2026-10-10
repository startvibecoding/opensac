# syntax=docker/dockerfile:1.7

# Container image for opensac.
#
# The image installs the same platform-independent npm package a release
# publishes (`scripts/build_node.ts` -> `dist/node`), so an image and an npm
# install of one tag report the same version. There is no compiled binary and no
# per-platform build step.
#
# The entry point is the shared Core host (`opensac core`): an image has no
# terminal for the Ink TUI, so the container exposes the Core HTTP API and the
# user mounts the workspace they want the agent to work in.

ARG NODE_VERSION=22
ARG VERSION=unknown

FROM node:${NODE_VERSION}-bookworm-slim AS builder
WORKDIR /src
# The dependency graph changes far less often than the sources, so caching it
# behind its own layer keeps most source edits from re-resolving the world.
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
# Build the platform-independent package, then drop the build-time
# node_modules/lock so the runtime image installs only the runtime dependencies.
RUN npm run build:node \
    && rm -rf dist/node/node_modules dist/node/package-lock.json

# The Core binds 127.0.0.1 by default, which nothing outside the container can
# reach, so the image ships a settings.json that listens on every interface.
# There is no auth by default; a deployment is expected to set a password in its
# own settings or terminate TLS in front of the port.
FROM builder AS seed
RUN mkdir -p /opensac \
    && printf '%s\n' '{"core":{"host":"0.0.0.0","port":27183}}' > /opensac/settings.json

FROM node:22-bookworm-slim AS runtime-ubuntu
ARG VERSION=unknown
LABEL org.opencontainers.image.source="https://github.com/startvibecoding/opensac" \
	org.opencontainers.image.title="OpenSAC" \
	org.opencontainers.image.description="OpenSAC terminal AI coding assistant" \
	org.opencontainers.image.licenses="MIT" \
	org.opencontainers.image.version="${VERSION}" \
	org.opencontainers.image.base.name="node:22-bookworm-slim"
RUN apt-get update \
	&& apt-get install -y --no-install-recommends \
		bash ca-certificates curl git less openssh-client ripgrep tzdata \
	&& rm -rf /var/lib/apt/lists/*
ENV OPENSAC_DIR=/opensac \
	OPENSAC_BUILD_VERSION=${VERSION}
COPY --from=builder /src/dist/node /opt/opensac
RUN npm install --global /opt/opensac && rm -rf /root/.npm
COPY --from=seed /opensac/settings.json /opensac/settings.json
WORKDIR /workspace
EXPOSE 27183
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
	CMD ["opensac", "core", "status"]
USER root
ENTRYPOINT ["opensac", "core"]

FROM node:22-bookworm-slim AS runtime-debian
ARG VERSION=unknown
LABEL org.opencontainers.image.source="https://github.com/startvibecoding/opensac" \
	org.opencontainers.image.title="OpenSAC" \
	org.opencontainers.image.description="OpenSAC terminal AI coding assistant" \
	org.opencontainers.image.licenses="MIT" \
	org.opencontainers.image.version="${VERSION}" \
	org.opencontainers.image.base.name="node:22-bookworm-slim"
RUN apt-get update \
	&& apt-get install -y --no-install-recommends \
		bash ca-certificates curl git less openssh-client ripgrep tzdata \
	&& rm -rf /var/lib/apt/lists/*
ENV OPENSAC_DIR=/opensac \
	OPENSAC_BUILD_VERSION=${VERSION}
COPY --from=builder /src/dist/node /opt/opensac
RUN npm install --global /opt/opensac && rm -rf /root/.npm
COPY --from=seed /opensac/settings.json /opensac/settings.json
WORKDIR /workspace
EXPOSE 27183
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
	CMD ["opensac", "core", "status"]
USER root
ENTRYPOINT ["opensac", "core"]

FROM node:22-alpine AS runtime-alpine
ARG VERSION=unknown
LABEL org.opencontainers.image.source="https://github.com/startvibecoding/opensac" \
	org.opencontainers.image.title="OpenSAC" \
	org.opencontainers.image.description="OpenSAC terminal AI coding assistant" \
	org.opencontainers.image.licenses="MIT" \
	org.opencontainers.image.version="${VERSION}" \
	org.opencontainers.image.base.name="node:22-alpine"
RUN apk add --no-cache \
	bash ca-certificates curl git less openssh-client ripgrep tzdata
ENV OPENSAC_DIR=/opensac \
	OPENSAC_BUILD_VERSION=${VERSION}
COPY --from=builder /src/dist/node /opt/opensac
RUN npm install --global /opt/opensac && rm -rf /root/.npm
COPY --from=seed /opensac/settings.json /opensac/settings.json
WORKDIR /workspace
EXPOSE 27183
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
	CMD ["opensac", "core", "status"]
USER root
ENTRYPOINT ["opensac", "core"]
