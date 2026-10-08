# opensac build system.
#
# `deno task` remains the interface for day-to-day development; this Makefile is
# the interface for releases. A release is a single platform-independent npm
# package (plain JS, bundled with esbuild and run on Node), not per-platform
# compiled binaries: `node-build` produces $(NODE_DIR), `node-pack` inspects it,
# and the `node-publish-*` targets push it to a registry.
#
# Publish targets are slow and hit a shared registry. Run them only when you
# intend to cut a release.

DENO ?= deno
NPM ?= npm
DOCKER ?= docker
DOCKER_IMAGE ?= ghcr.io/startvibecoding/opensac
NPM_REGISTRY ?= https://registry.npmjs.org
NPM_REGISTRY_GITHUB ?= https://npm.pkg.github.com
DIST_DIR := dist
NODE_DIR := $(DIST_DIR)/node
DOCKER_TAG ?= local

# GitHub Packages only accepts a package inside the owner's scope, so the scoped
# build names the package `@owner/opensac` and publishes to that registry.
NODE_SCOPE ?=

# The product version follows the newest `v*` git tag, falling back to the
# deno.json version, and is embedded into the published package at build time.
VERSION := $(shell $(DENO) run -A scripts/version.ts 2>/dev/null)

.PHONY: help node-build node-pack node-publish node-publish-pre \
        node-publish-github install run test test-arch test-all check lint \
        fmt check-fmt fuzz version clean clean-all docker-build

help:
	@echo "opensac build system"
	@echo ""
	@echo "Release targets (npm, platform-independent JS):"
	@echo "  node-build            Build the Node package into $(NODE_DIR)/"
	@echo "  node-pack             Build and pack a tarball into $(DIST_DIR)/npm/"
	@echo "  node-publish          Publish $(NODE_DIR) under the latest tag"
	@echo "  node-publish-pre      Publish $(NODE_DIR) under the next tag"
	@echo "  node-publish-github   Publish a scoped build to GitHub Packages (NODE_SCOPE=@owner)"
	@echo ""
	@echo "Development targets:"
	@echo "  install          Install the CLI globally from source"
	@echo "  run              Start the TUI from source"
	@echo "  test             Run the test suite"
	@echo "  test-arch        Run the architecture guard tests"
	@echo "  test-all         Run the test suite and the architecture guards"
	@echo "  check            Type check src/, sdk/, examples/, and scripts/"
	@echo "  lint             Run the linter"
	@echo "  fmt              Format the repository"
	@echo "  check-fmt        Verify formatting without writing changes"
	@echo "  fuzz             Run the property-based tests"
	@echo "  version          Print the version a build would embed"
	@echo ""
	@echo "Other targets:"
	@echo "  docker-build    Build the local container image"
	@echo "  clean           Remove build output"
	@echo "  clean-all       Remove build output, including dist/ and packed tarballs"
	@echo "  help            Show this help"

# Release

node-build:
	$(DENO) task build:node
	@if [ -n "$(NODE_SCOPE)" ]; then \
		$(DENO) run -A scripts/build_node.ts --scope=$(NODE_SCOPE); \
	fi

node-pack:
	$(DENO) task pack:node

node-publish:
	$(DENO) task build:node
	$(DENO) run -A scripts/npm_publish_if_needed.ts \
		--tag latest --registry $(NPM_REGISTRY) $(NODE_DIR)

node-publish-pre:
	$(DENO) task build:node
	$(DENO) run -A scripts/npm_publish_if_needed.ts \
		--tag next --registry $(NPM_REGISTRY) $(NODE_DIR)

node-publish-github:
	@if [ -z "$(NODE_SCOPE)" ]; then \
		echo "NODE_SCOPE is required, e.g. make node-publish-github NODE_SCOPE=@owner"; \
		exit 1; \
	fi
	$(DENO) run -A scripts/build_node.ts --scope=$(NODE_SCOPE)
	$(DENO) run -A scripts/npm_publish_if_needed.ts \
		--tag latest --registry $(NPM_REGISTRY_GITHUB) $(NODE_DIR)

# Development

install:
	$(DENO) task install

run:
	$(DENO) task run

test:
	$(DENO) task test

test-arch:
	$(DENO) task test:architecture

# `deno task test` already includes src/architecture; this alias exists so a
# release checklist can name the guard explicitly.
test-all: test test-arch

check:
	$(DENO) task check

lint:
	$(DENO) task lint

fmt:
	$(DENO) fmt

check-fmt:
	$(DENO) fmt --check

fuzz:
	$(DENO) task fuzz

version:
	@echo $(VERSION)

# Container image

docker-build:
	$(DOCKER) build --build-arg VERSION=$(VERSION) \
		-t $(DOCKER_IMAGE):$(DOCKER_TAG) -t $(DOCKER_IMAGE):local .

# Clean

clean:
	rm -rf bin/ $(DIST_DIR)/node $(DIST_DIR)/npm

clean-all: clean
	rm -rf $(DIST_DIR)
