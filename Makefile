## Flux — build targets
##
## Usage: make <target>
##

MODULE   := abagile.com/tokyo3/flux
CMD_FLUX := ./cmd/flux

BIN_DIR  := bin
FLUX_BIN := $(BIN_DIR)/flux

GIT_TAG    := $(shell git describe --tags --exact-match 2>/dev/null || true)
GIT_COMMIT := $(shell git rev-parse --short HEAD 2>/dev/null || echo unknown)
VERSION    := $(if $(GIT_TAG),$(GIT_TAG),dev-$(GIT_COMMIT))

LDFLAGS := -s -w -X main.Version=$(VERSION)

GO      := go
GOFLAGS :=

# Frontend tools are pinned; override BIOME/RUMDL to use installed binaries.
BIOME_VERSION := 2.5.14
RUMDL_VERSION := 0.2.77
TYPESCRIPT_VERSION := 7.0.2
BIOME ?= npx --yes @biomejs/biome@$(BIOME_VERSION)
RUMDL ?= uvx rumdl@$(RUMDL_VERSION)
TSC ?= npx --yes -p typescript@$(TYPESCRIPT_VERSION) tsc
WEB_JS = internal/planningui/static/app.js $(wildcard internal/planningui/static/modules/*.js)

IMAGE_NAME ?= abagile/tokyo3-flux
IMAGE_TAG  ?= $(VERSION)

.PHONY: all build build-linux build-linux-amd64 build-darwin \
        test tidy vet lint check fmt-web lint-web typecheck-web fmt-md check-web test-web \
        docker-build docker-build-amd64 docker-push \
        docker-up docker-down install clean help

all: build

# ── Build ─────────────────────────────────────────────────────────────────────

## build: Compile flux into ./bin/
build: $(BIN_DIR)
	$(GO) build $(GOFLAGS) -ldflags "$(LDFLAGS)" -o $(FLUX_BIN) $(CMD_FLUX)
	@echo "  built $(FLUX_BIN) ($(VERSION))"

$(BIN_DIR):
	mkdir -p $(BIN_DIR)

## build-linux: Cross-compile for Linux arm64 (default)
build-linux: $(BIN_DIR)
	GOOS=linux GOARCH=arm64 $(GO) build -ldflags "$(LDFLAGS)" -o $(BIN_DIR)/flux-linux-arm64 $(CMD_FLUX)
	@echo "  built flux-linux-arm64"

## build-linux-amd64: Cross-compile for Linux amd64
build-linux-amd64: $(BIN_DIR)
	GOOS=linux GOARCH=amd64 $(GO) build -ldflags "$(LDFLAGS)" -o $(BIN_DIR)/flux-linux-amd64 $(CMD_FLUX)
	@echo "  built flux-linux-amd64"

## build-darwin: Cross-compile for macOS arm64
build-darwin: $(BIN_DIR)
	GOOS=darwin GOARCH=arm64 $(GO) build -ldflags "$(LDFLAGS)" -o $(BIN_DIR)/flux-darwin-arm64 $(CMD_FLUX)
	@echo "  built flux-darwin-arm64"

# ── Quality ───────────────────────────────────────────────────────────────────

## test: Run all tests
test:
	$(GO) test ./... -count=1

## tidy: Run go mod tidy
tidy:
	$(GO) mod tidy

## vet: Run go vet
vet:
	$(GO) vet ./...

## lint: Run staticcheck
lint:
	staticcheck ./...

.PHONY: vendor-web
## vendor-web: Rebuild the checked-in Preact/HTM runtime (versions in tools/vendor/package-lock.json)
vendor-web:
	cd tools/vendor && npm ci --ignore-scripts && npm run build

## fmt-web: Format frontend JS/CSS, tests and the Pi extension with Biome
fmt-web:
	$(BIOME) format --write .

## lint-web: Lint frontend JS/CSS, tests and the Pi extension, and check rendering guardrails
lint-web:
	$(BIOME) lint .
	node tools/lint-web.mjs

## typecheck-web: Type-check the frontend modules against their JSDoc and tools/types/flux.d.ts
typecheck-web:
	$(TSC) -p tools/types/tsconfig.json

## fmt-md: Reflow Markdown docs to one sentence per line
fmt-md:
	$(RUMDL) check --fix .

## check-web: Verify frontend and Markdown formatting and lint without changes
check-web:
	$(BIOME) ci --diagnostic-level=error .
	node tools/lint-web.mjs
	$(TSC) -p tools/types/tsconfig.json
	$(RUMDL) check .

## test-web: Syntax-check browser modules and run the Node tests
test-web:
	@for f in $(WEB_JS); do node --check $$f || exit 1; done
	node tests/extension.test.mjs
	node tests/date-format.test.mjs

## check: Full Go verification sequence, then the frontend checks
check:
	gofmt -s -w .
	$(GO) mod tidy
	$(GO) test ./... -count=1
	$(GO) vet ./...
	staticcheck ./...
	find . -type f -name "*.go" -print0 | xargs -0 -n 100 gopls check -severity=hint
	govulncheck ./...
	@out=$$(deadcode -test ./...); if [ -n "$$out" ]; then echo "$$out"; echo "deadcode: unreachable functions found (above)"; exit 1; fi
	$(MAKE) check-web test-web

# ── Docker ────────────────────────────────────────────────────────────────────

## docker-build: Build the server image for Linux arm64 (default)
docker-build:
	docker build \
	  --platform linux/arm64 \
	  --build-arg TARGETOS=linux \
	  --build-arg TARGETARCH=arm64 \
	  --build-arg VERSION=$(VERSION) \
	  --target server \
	  -t $(IMAGE_NAME):$(IMAGE_TAG) \
	  -t $(IMAGE_NAME):latest \
	  .
	@echo "  built $(IMAGE_NAME):$(IMAGE_TAG)"

## docker-build-amd64: Build the server image for Linux amd64
docker-build-amd64:
	docker build \
	  --platform linux/amd64 \
	  --build-arg TARGETOS=linux \
	  --build-arg TARGETARCH=amd64 \
	  --build-arg VERSION=$(VERSION) \
	  --target server \
	  -t $(IMAGE_NAME):$(IMAGE_TAG)-amd64 \
	  .

## docker-push: Push the arm64 image to its registry
docker-push: docker-build
	docker push $(IMAGE_NAME):$(IMAGE_TAG)
	docker push $(IMAGE_NAME):latest

# ── Compose ───────────────────────────────────────────────────────────────────

## docker-up: Start Flux with the local compose configuration
docker-up:
	docker compose up -d --build --wait

## docker-down: Stop Flux while preserving its state volume
docker-down:
	docker compose down

# ── Install / clean ───────────────────────────────────────────────────────────

## install: Install flux to GOPATH/bin
install:
	$(GO) install -ldflags "$(LDFLAGS)" $(CMD_FLUX)

## clean: Remove build artifacts
clean:
	rm -rf $(BIN_DIR)

## help: Show this help
help:
	@awk '/^##/ { \
	  line=$$0; sub(/^## ?/, "", line); \
	  if (line ~ /^[a-z0-9_.-]+:/) { \
	    target=line; sub(/:.*/, "", target); \
	    desc=line; sub(/^[^:]+:[[:space:]]*/, "", desc); \
	    names[++n]=target; docs[target]=desc; \
	  } else header[++h]=line; \
	} END { \
	  for (i=1; i<=h; i++) print header[i]; \
	  for (i=1; i<=n; i++) printf "  %-22s %s\\n", names[i], docs[names[i]]; \
	}' $(MAKEFILE_LIST)
