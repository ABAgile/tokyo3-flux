# Multi-stage image for Flux.

FROM --platform=$BUILDPLATFORM golang:1.26-alpine AS builder

ARG TARGETOS=linux
ARG TARGETARCH=arm64
ARG VERSION=dev

WORKDIR /src

COPY go.mod go.sum ./
RUN go mod download

COPY cmd/ cmd/
COPY internal/ internal/

RUN CGO_ENABLED=0 GOOS=${TARGETOS} GOARCH=${TARGETARCH} \
    go build -trimpath -ldflags="-s -w -X main.Version=${VERSION}" -o /out/flux ./cmd/flux

FROM alpine:3.21 AS server

RUN apk add --no-cache ca-certificates tini tzdata \
    && addgroup -S flux \
    && adduser -S -G flux flux \
    && mkdir -p /var/lib/flux \
    && chown -R flux:flux /var/lib/flux

COPY --from=builder /out/flux /usr/local/bin/flux

USER flux
WORKDIR /var/lib/flux
VOLUME ["/var/lib/flux"]
EXPOSE 8080

ENTRYPOINT ["/sbin/tini", "--", "/usr/local/bin/flux"]
CMD ["serve"]
