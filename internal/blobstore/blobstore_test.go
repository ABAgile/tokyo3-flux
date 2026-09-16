package blobstore

import (
	"context"
	"errors"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestLocalRoundTripAndIsolation(t *testing.T) {
	store, err := NewLocal(t.TempDir(), 32)
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	info, err := store.Put(context.Background(), "attachments/item-1", strings.NewReader("hello"), "text/plain")
	if err != nil {
		t.Fatal(err)
	}
	if info.Key != "attachments/item-1" || info.Size != 5 || info.Digest == "" || info.ContentType != "text/plain" {
		t.Fatalf("unexpected info: %+v", info)
	}
	object, err := store.Open(context.Background(), info.Key)
	if err != nil {
		t.Fatal(err)
	}
	data, err := io.ReadAll(object.Reader)
	closeErr := object.Reader.Close()
	if err != nil || closeErr != nil || string(data) != "hello" {
		t.Fatalf("read %q, read error %v, close error %v", data, err, closeErr)
	}
	if err := store.Delete(context.Background(), info.Key); err != nil {
		t.Fatal(err)
	}
	if _, err := store.Open(context.Background(), info.Key); !errors.Is(err, ErrNotFound) {
		t.Fatalf("open deleted object: %v", err)
	}
}

func TestLocalRejectsSymlinkEscape(t *testing.T) {
	root, outside := t.TempDir(), t.TempDir()
	if err := os.WriteFile(filepath.Join(outside, "secret"), []byte("secret"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(outside, filepath.Join(root, "nested")); err != nil {
		t.Skipf("symlinks unavailable: %v", err)
	}
	store, err := NewLocal(root, 32)
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	if _, err = store.Put(context.Background(), "nested/blob", strings.NewReader("escape"), "text/plain"); err == nil {
		t.Fatal("put followed a symlink outside the blobstore")
	}
	if _, err = store.Open(context.Background(), "nested/secret"); err == nil {
		t.Fatal("open followed a symlink outside the blobstore")
	}
}

func TestLocalRejectsTraversalAndOversize(t *testing.T) {
	root := t.TempDir()
	store, err := NewLocal(root, 4)
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	for _, key := range []string{"../outside", "/absolute", "attachments/../outside", "attachments\\outside"} {
		if _, err := store.Put(context.Background(), key, strings.NewReader("x"), "text/plain"); !errors.Is(err, ErrInvalidKey) {
			t.Errorf("key %q returned %v", key, err)
		}
	}
	if _, err := store.Put(context.Background(), "too-large", strings.NewReader("12345"), "text/plain"); !errors.Is(err, ErrTooLarge) {
		t.Fatalf("oversize returned %v", err)
	}
	entries, err := os.ReadDir(root)
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 0 {
		t.Fatalf("oversize upload left files: %+v", entries)
	}
}

func TestConfigFromEnv(t *testing.T) {
	t.Setenv("TEST_BLOBSTORE", "nats")
	t.Setenv("TEST_NATS_CREDS", "/tmp/test.creds")
	cfg, err := ConfigFromEnv("TEST", NATSConfig{URL: "nats://default:4222"})
	if err != nil {
		t.Fatal(err)
	}
	if cfg.Backend != "nats" || cfg.NATS.URL != "nats://default:4222" || cfg.NATS.Credentials != "/tmp/test.creds" {
		t.Fatalf("unexpected config: %+v", cfg)
	}
	t.Setenv("TEST_ATTACHMENT_MAX_BYTES", "0")
	if _, err := ConfigFromEnv("TEST", NATSConfig{}); err == nil {
		t.Fatal("accepted zero attachment limit")
	}
}

func TestCanceledPut(t *testing.T) {
	store, err := NewLocal(t.TempDir(), 32)
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := store.Put(ctx, "cancelled", strings.NewReader("data"), "text/plain"); !errors.Is(err, context.Canceled) {
		t.Fatalf("canceled put returned %v", err)
	}
}
