# hdl-connect-view - compile, test and package the VS Code extension.
#
#   make            compile + test + package -> dist/<name>-<version>.vsix
#   make help       every target, one line each
#
# Packaging needs the @vscode/vsce CLI. It is fetched on demand with npx, so
# there is nothing to install by hand and no devDependency is added for it. To
# use your own copy instead (offline builds, a pinned version):
#
#   make vsix VSCE=./node_modules/.bin/vsce
#
# The test suite runs before packaging on purpose: a vsix is a release, and
# shipping a red build is worse than a slow one.

SHELL := /bin/bash
# One thing at a time. `compile` is a phony prerequisite of both `check` and
# `package`, so without this `make -j` could run tsc twice into the same out/.
.NOTPARALLEL:
.DEFAULT_GOAL := vsix

NAME    := $(shell node -p "require('./package.json').name")
VERSION := $(shell node -p "require('./package.json').version")
DIST    := dist
VSIX    := $(DIST)/$(NAME)-$(VERSION).vsix
OUT     := out
STAMP   := node_modules/.deps-ok

NPM ?= npm
NODE ?= node
# Pinned to a major: a new major of vsce may add required flags.
VSCE ?= npx --yes @vscode/vsce@4
# This extension is not published from a public repository, so there is no URL
# to put in package.json; and no LICENSE file exists yet (the manifest says
# MIT). Both are vsce warnings, not errors - drop this variable once a
# repository field and a LICENSE file are in place.
VSCE_PACKAGE_FLAGS ?= --allow-missing-repository --skip-license
CODE ?= code

.PHONY: help vsix package install check compile test e2e contents deps version clean distclean

## vsix: compile, run the tests, then package (default target)
vsix: check package
	@echo "packaged $(VSIX) ($$(du -h $(VSIX) | cut -f1))"

## package: package the compiled extension with vsce
package: compile
	@mkdir -p $(DIST)
	$(VSCE) package --no-dependencies --out $(VSIX) $(VSCE_PACKAGE_FLAGS)
	@test -f $(VSIX) || { echo "vsce reported success but $(VSIX) is missing"; exit 1; }

## install: install the built vsix into the local VS Code
install: vsix
	@command -v $(CODE) >/dev/null 2>&1 || { \
		echo "'$(CODE)' is not on PATH, so the extension cannot be installed."; \
		echo "Install the .vsix by hand: $(PWD)/$(VSIX)"; \
		exit 1; }
	$(CODE) --install-extension $(VSIX) --force

## check: compile, unit tests and the fixture end-to-end check
check: compile test e2e

## compile: tsc -p ./
compile: deps
	$(NPM) run compile

## test: unit tests (out/test)
test: compile
	$(NODE) --test $(OUT)/test/

## e2e: end-to-end check over test/fixtures
e2e: compile
	$(NODE) $(OUT)/tools/e2e.js

## contents: list the files that would go into the vsix
contents: compile
	@# `vsce ls` takes none of the package flags, so it gets none of them.
	$(VSCE) ls

## deps: install node dependencies when package.json is newer than the stamp
deps: $(STAMP)
$(STAMP): package.json package-lock.json
	$(NPM) install --no-audit --no-fund
	@touch $@

## version: print the version that would be packaged
version:
	@echo $(VERSION)

## clean: remove the compiled output
clean:
	rm -rf $(OUT)

## distclean: clean plus the packaged vsix files
distclean: clean
	rm -rf $(DIST)

help:
	@echo 'hdl-connect-view $(VERSION) - targets:'
	@grep -E '^## ' $(MAKEFILE_LIST) \
		| sed -e 's/^## //' \
		| awk -F': ' '{ printf "  \033[36m%-11s\033[0m %s\n", $$1, $$2 }'
	@echo
	@echo '  vsix       -> $(VSIX)'
