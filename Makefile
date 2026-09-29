# opensac build system.
#
# `deno task` remains the interface for day-to-day development; this Makefile is
# the interface for releases, where several steps have to run in order across
# platforms and package registries. Every target here is also runnable by hand:
# nothing is hidden behind make-only state.
#
# Release targets (build-all, npm-*) are slow and publish to a shared registry.
# Run them only when you intend to cut a release.

DENO ?= deno
NPM ?= npm
NPM_REGISTRY ?= https://registry.npmjs.org
BINARY_NAME := opensac
INSTALLER_NAME := opensac-installer
DIST_DIR := dist

# The product version follows the newest `v*` git tag, the same source the
# compiled binary embeds, so npm and the binary can never disagree.
VERSION := $(shell $(DENO) run -A scripts/build.ts --version 2>/dev/null)
NPM_VERSION := $(patsubst v%,%,$(VERSION))
PRE_VERSION := $(if $(filter %-pre,$(NPM_VERSION)),$(NPM_VERSION),$(NPM_VERSION)-pre)

# Platform package directory names, derived from the shared platform table.
# Listing them from the table rather than a filesystem wildcard matters: a
# wildcard is expanded when the Makefile is parsed, before `npm-packages` has
# generated anything, so a wildcard loop would silently publish zero packages.
PLATFORM_PACKAGES := $(shell $(DENO) eval --quiet \
	'import { PLATFORM_TARGETS } from "./scripts/platforms.ts"; \
	 console.log(PLATFORM_TARGETS.map((t) => `npm/packages/$(INSTALLER_NAME)-$${t.npmPlatform}`).join(" "))' \
	2>/dev/null)

.PHONY: help build build-linux build-darwin build-windows build-all install run \
        test test-arch test-all check lint fmt check-fmt fuzz version \
        clean clean-all \
        npm-packages npm-pack npm-verify-platforms npm-publish-all npm-publish-pre

help:
	@echo "opensac build system"
	@echo ""
	@echo "Build targets:"
	@echo "  build            Build for the current platform (bin/$(BINARY_NAME))"
	@echo "  build-linux      Build for Linux x64 and arm64"
	@echo "  build-darwin     Build for macOS x64 and arm64"
	@echo "  build-windows    Build for Windows x64 and arm64"
	@echo "  build-all        Build every published platform"
	@echo ""
	@echo "Development targets:"
	@echo "  install          Install the CLI globally from source"
	@echo "  run              Build and start the TUI"
	@echo "  test             Run the test suite"
	@echo "  test-arch        Run the architecture guard tests"
	@echo "  test-all         Run the test suite and the architecture guards"
	@echo "  check            Type check src/, sdk/, examples/, and scripts/"
	@echo "  lint             Run the linter"
	@echo "  fmt              Format the repository"
	@echo "  check-fmt        Verify formatting without writing changes"
	@echo "  fuzz             Run the property-based tests"
	@echo "  version          Print the version that a build would embed"
	@echo ""
	@echo "NPM targets (release only):"
	@echo "  npm-packages           Build platform packages from bin/"
	@echo "  npm-pack               Pack tarballs into $(DIST_DIR)/npm/ without publishing"
	@echo "  npm-verify-platforms   Check that every platform package is published"
	@echo "  npm-publish-all        Publish platform packages, then the entry package"
	@echo "  npm-publish-pre        Publish the same set under the next tag"
	@echo ""
	@echo "Other targets:"
	@echo "  clean          Remove build output"
	@echo "  clean-all      Remove build output, including dist/ and packed tarballs"
	@echo "  help           Show this help"

# Development

build:
	$(DENO) task build

build-linux:
	$(DENO) run -A scripts/build.ts --target=linux-x64
	$(DENO) run -A scripts/build.ts --target=linux-arm64

build-darwin:
	$(DENO) run -A scripts/build.ts --target=darwin-x64
	$(DENO) run -A scripts/build.ts --target=darwin-arm64

build-windows:
	$(DENO) run -A scripts/build.ts --target=win32-x64
	$(DENO) run -A scripts/build.ts --target=win32-arm64

# Every platform the npm packages are published for. Deno downloads a target
# runtime on first use, so the first cross build is the slow one.
build-all:
	$(DENO) run -A scripts/build.ts --all

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

# Clean

clean:
	rm -rf bin/
	rm -rf npm/packages/ npm/bin/ npm/scripts/

clean-all: clean
	rm -rf $(DIST_DIR)

# NPM release targets
#
# The entry package's `optionalDependencies` select a platform package by
# os/cpu, and npm silently skips a dependency that is not published. So the
# platform packages go first, are verified as present, and only then is the
# entry package published.

# Generate the platform packages from the binaries in bin/. Run `build-all`
# first; platforms without a binary are skipped rather than published empty.
npm-packages:
	$(DENO) run -A scripts/build_npm_packages.ts

# Pack every package into $(DIST_DIR)/npm/ for inspection. Publishes nothing.
npm-pack: npm-packages
	$(DENO) run -A scripts/npm_pack.ts

# Fail unless every optionalDependencies entry exists on the registry at the
# version the entry manifest pins.
npm-verify-platforms:
	$(DENO) run -A scripts/npm_verify_platforms.ts npm/package.json

# Publishes each platform package, verifies, then publishes the entry package.
# npm_publish_if_needed.ts skips a version that is already on the registry, so
# a re-run after a partial failure resumes instead of erroring.
npm-publish-all: npm-packages
	@set -e; for dir in $(PLATFORM_PACKAGES); do \
		[ -f "$$dir/package.json" ] || continue; \
		echo "Publishing platform package $$(basename $$dir)..."; \
		$(DENO) run -A scripts/npm_publish_if_needed.ts \
			--tag latest --registry $(NPM_REGISTRY) "$$dir"; \
	done
	$(MAKE) npm-verify-platforms
	@echo "Publishing $(INSTALLER_NAME)..."
	$(DENO) run -A scripts/npm_publish_if_needed.ts \
		--tag latest --registry $(NPM_REGISTRY) npm

# Pre-release: the same package set under the `next` tag. The version is left
# to the caller's tagging, since npm derives it from the git tag.
npm-publish-pre: npm-packages
	@set -e; for dir in $(PLATFORM_PACKAGES); do \
		[ -f "$$dir/package.json" ] || continue; \
		echo "Publishing platform package $$(basename $$dir) (pre-release)..."; \
		$(DENO) run -A scripts/npm_publish_if_needed.ts \
			--tag next --registry $(NPM_REGISTRY) "$$dir"; \
	done
	$(MAKE) npm-verify-platforms
	@echo "Publishing $(INSTALLER_NAME) (pre-release)..."
	$(DENO) run -A scripts/npm_publish_if_needed.ts \
		--tag next --registry $(NPM_REGISTRY) npm
