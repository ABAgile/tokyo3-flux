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

IMAGE_NAME ?= abagile/tokyo3-flux
IMAGE_TAG  ?= $(VERSION)

.PHONY: all build build-linux build-linux-amd64 build-darwin \
        test tidy vet lint check \
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

## check: Full Go verification sequence
check:
	gofmt -s -w .
	$(GO) mod tidy
	$(GO) test ./... -count=1
	$(GO) vet ./...
	staticcheck ./...
	find . -type f -name "*.go" -print0 | xargs -0 -n 100 gopls check -severity=hint
	govulncheck ./...
	@out=$$(deadcode -test ./...); if [ -n "$$out" ]; then echo "$$out"; echo "deadcode: unreachable functions found (above)"; exit 1; fi

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
