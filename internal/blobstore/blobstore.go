// Package blobstore provides bounded attachment storage for Flux.
//
// The store deliberately keeps object keys separate from user-visible
// filenames. Local objects are written atomically below a private directory;
// NATS objects live in a JetStream Object Store bucket.
package blobstore

import (
	"context"
	cryptorand "crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"os"
	"path"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"

	basenats "github.com/abagile/tokyo3-base/nats"
	"github.com/nats-io/nats.go"
)

const DefaultMaxBytes int64 = 20 << 20

var (
	ErrInvalidKey = errors.New("invalid blob key")
	ErrNotFound   = errors.New("blob not found")
	ErrTooLarge   = errors.New("blob exceeds the configured size limit")
)

// ObjectInfo describes the bytes stored under a generated key. Digest uses
// the stable Flux form sha256:<lowercase hex>; it is calculated before Put
// returns for both backends.
type ObjectInfo struct {
	Key         string
	Size        int64
	Digest      string
	ContentType string
}

// Object is a streamed object returned by Open. Verify, when non-nil, must be
// called after the reader reaches EOF. NATS uses it to surface its digest
// verification result; local files do not need a second verification pass.
type Object struct {
	ObjectInfo
	Reader io.ReadCloser
	Verify func() error
}

// Store is the common attachment backend contract.
type Store interface {
	Put(context.Context, string, io.Reader, string) (ObjectInfo, error)
	Open(context.Context, string) (Object, error)
	Delete(context.Context, string) error
	Close() error
}

// Config selects a backend. Backend accepts filesystem (or local) and nats.
type Config struct {
	Backend  string
	Path     string
	MaxBytes int64
	NATS     NATSConfig
}

// NATSConfig contains the connection and Object Store settings. Credentials
// is an optional NATS .creds file; mTLS files are used when supplied.
type NATSConfig struct {
	URL         string
	CertFile    string
	KeyFile     string
	CAFile      string
	Credentials string
	Bucket      string
}

// ConfigFromEnv resolves FLUX attachment storage settings. The optional NATS
// argument is the already-resolved application NATS material and supplies
// defaults for the object-store connection.
func ConfigFromEnv(prefix string, defaults NATSConfig) (Config, error) {
	prefix = strings.TrimSpace(prefix)
	if prefix == "" || strings.ContainsAny(prefix, "\r\n") {
		return Config{}, errors.New("blobstore environment prefix is invalid")
	}
	backend := firstEnv(prefix+"_BLOBSTORE", prefix+"_BLOBSTORE_BACKEND",
		prefix+"_ATTACHMENT_STORE", prefix+"_ATTACHMENT_BACKEND", prefix+"_ATTACHMENTS_BACKEND")
	if backend == "" {
		backend = "filesystem"
	}
	backend = strings.ToLower(strings.TrimSpace(backend))
	switch backend {
	case "filesystem", "local", "fs", "file":
		backend = "filesystem"
	case "nats", "nats-object-store", "object-store", "nats-object":
		backend = "nats"
	default:
		return Config{}, fmt.Errorf("%s_BLOBSTORE must be filesystem or nats", prefix)
	}

	maxBytes := DefaultMaxBytes
	if raw := firstEnv(prefix+"_ATTACHMENT_MAX_BYTES", prefix+"_ATTACHMENTS_MAX_BYTES", prefix+"_BLOBSTORE_MAX_BYTES"); raw != "" {
		parsed, err := strconv.ParseInt(strings.TrimSpace(raw), 10, 64)
		if err != nil || parsed <= 0 || parsed > DefaultMaxBytes {
			return Config{}, fmt.Errorf("%s_ATTACHMENT_MAX_BYTES must be between 1 and 20971520", prefix)
		}
		maxBytes = parsed
	}

	natsURL := firstEnv(prefix+"_BLOBSTORE_NATS_URL", prefix+"_ATTACHMENT_NATS_URL", prefix+"_ATTACHMENTS_NATS_URL", prefix+"_NATS_URL")
	if natsURL == "" {
		natsURL = strings.TrimSpace(defaults.URL)
	}
	certFile := firstEnv(prefix+"_BLOBSTORE_NATS_CERT", prefix+"_ATTACHMENT_NATS_CERT", prefix+"_ATTACHMENTS_NATS_CERT", prefix+"_NATS_CERT")
	if certFile == "" {
		certFile = strings.TrimSpace(defaults.CertFile)
	}
	keyFile := firstEnv(prefix+"_BLOBSTORE_NATS_KEY", prefix+"_ATTACHMENT_NATS_KEY", prefix+"_ATTACHMENTS_NATS_KEY", prefix+"_NATS_KEY")
	if keyFile == "" {
		keyFile = strings.TrimSpace(defaults.KeyFile)
	}
	caFile := firstEnv(prefix+"_BLOBSTORE_NATS_CA", prefix+"_ATTACHMENT_NATS_CA", prefix+"_ATTACHMENTS_NATS_CA", prefix+"_NATS_CA")
	if caFile == "" {
		caFile = strings.TrimSpace(defaults.CAFile)
	}
	credentials := firstEnv(prefix+"_BLOBSTORE_NATS_CREDS", prefix+"_ATTACHMENT_NATS_CREDS", prefix+"_ATTACHMENTS_NATS_CREDS", prefix+"_NATS_CREDS")
	if credentials == "" {
		credentials = strings.TrimSpace(defaults.Credentials)
	}
	bucket := firstEnv(prefix+"_BLOBSTORE_NATS_BUCKET", prefix+"_ATTACHMENTS_NATS_BUCKET")
	if bucket == "" {
		bucket = strings.TrimSpace(defaults.Bucket)
	}
	cfg := Config{
		Backend: backend,
		Path: firstEnv(prefix+"_BLOBSTORE_PATH", prefix+"_BLOBSTORE_DIR",
			prefix+"_ATTACHMENT_PATH", prefix+"_ATTACHMENT_DIR", prefix+"_ATTACHMENTS_PATH", prefix+"_ATTACHMENTS_DIR"),
		MaxBytes: maxBytes,
		NATS: NATSConfig{
			URL: natsURL, CertFile: certFile, KeyFile: keyFile,
			CAFile: caFile, Credentials: credentials, Bucket: bucket,
		},
	}
	if cfg.Path == "" {
		cfg.Path = "attachments"
	}
	if cfg.NATS.Bucket == "" {
		cfg.NATS.Bucket = "FLUX_ATTACHMENTS"
	}
	if strings.ContainsAny(cfg.Path, "\x00\r\n") || strings.ContainsAny(cfg.NATS.URL, "\r\n") ||
		strings.ContainsAny(cfg.NATS.Credentials, "\r\n") || strings.ContainsAny(cfg.NATS.CertFile, "\r\n") ||
		strings.ContainsAny(cfg.NATS.KeyFile, "\r\n") || strings.ContainsAny(cfg.NATS.CAFile, "\r\n") {
		return Config{}, fmt.Errorf("%s attachment settings cannot contain newlines", prefix)
	}
	if backend == "nats" && !bucketPattern.MatchString(cfg.NATS.Bucket) {
		return Config{}, fmt.Errorf("%s_BLOBSTORE_NATS_BUCKET is invalid", prefix)
	}
	if backend == "nats" && strings.TrimSpace(cfg.NATS.URL) == "" {
		return Config{}, fmt.Errorf("%s_NATS_URL is required when %s_BLOBSTORE=nats", prefix, prefix)
	}
	return cfg, nil
}

func firstEnv(names ...string) string {
	for _, name := range names {
		if value := strings.TrimSpace(os.Getenv(name)); value != "" {
			return value
		}
	}
	return ""
}

// New opens a configured store using a background startup context. Open is
// available when the caller needs a bounded context for NATS setup.
func New(cfg Config) (Store, error) { return Open(context.Background(), cfg) }

// Open constructs the selected store.
func Open(ctx context.Context, cfg Config) (Store, error) {
	if cfg.MaxBytes <= 0 {
		cfg.MaxBytes = DefaultMaxBytes
	}
	switch strings.ToLower(strings.TrimSpace(cfg.Backend)) {
	case "", "filesystem", "local", "fs", "file":
		return NewLocal(cfg.Path, cfg.MaxBytes)
	case "nats", "nats-object-store", "object-store", "nats-object":
		return NewNATS(ctx, cfg.NATS, cfg.MaxBytes)
	default:
		return nil, errors.New("blobstore backend must be filesystem or nats")
	}
}

// NewLocal creates a filesystem-backed store and its private root directory.
func NewLocal(root string, limits ...int64) (Store, error) {
	maxBytes := boundedMax(limits)
	if strings.TrimSpace(root) == "" {
		root = "attachments"
	}
	if err := os.MkdirAll(root, 0o700); err != nil {
		return nil, fmt.Errorf("create local blobstore: %w", err)
	}
	info, err := os.Lstat(root)
	if err != nil {
		return nil, fmt.Errorf("stat local blobstore: %w", err)
	}
	if !info.IsDir() {
		return nil, errors.New("local blobstore path is not a directory")
	}
	if err = os.Chmod(root, 0o700); err != nil {
		return nil, fmt.Errorf("protect local blobstore: %w", err)
	}
	rootDir, err := os.OpenRoot(root)
	if err != nil {
		return nil, fmt.Errorf("open local blobstore: %w", err)
	}
	return &localStore{root: rootDir, maxBytes: maxBytes}, nil
}

type localStore struct {
	root     *os.Root
	maxBytes int64
}

func (s *localStore) Put(ctx context.Context, key string, source io.Reader, contentType string) (ObjectInfo, error) {
	var out ObjectInfo
	relative, err := s.relativeKey(key)
	if err != nil {
		return out, err
	}
	if source == nil {
		return out, errors.New("blob source is nil")
	}
	directory := filepath.Dir(relative)
	if err = s.root.MkdirAll(directory, 0o700); err != nil {
		return out, fmt.Errorf("create local blob directory: %w", err)
	}
	temporaryName := filepath.Join(directory, ".flux-blob-"+cryptorand.Text())
	temporary, err := s.root.OpenFile(temporaryName, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
	if err != nil {
		return out, fmt.Errorf("create local blob: %w", err)
	}
	removeTemporary := true
	defer func() {
		if removeTemporary {
			_ = s.root.Remove(temporaryName)
		}
	}()
	hash := sha256.New()
	reader := io.LimitReader(&contextReader{ctx: ctx, reader: source}, s.maxBytes+1)
	count, copyErr := io.Copy(io.MultiWriter(temporary, hash), reader)
	if copyErr != nil {
		_ = temporary.Close()
		return out, copyErr
	}
	if count > s.maxBytes {
		_ = temporary.Close()
		return out, ErrTooLarge
	}
	if err = temporary.Sync(); err != nil {
		_ = temporary.Close()
		return out, fmt.Errorf("sync local blob: %w", err)
	}
	if err = temporary.Close(); err != nil {
		return out, fmt.Errorf("close local blob: %w", err)
	}
	if err = s.root.Rename(temporaryName, relative); err != nil {
		return out, fmt.Errorf("commit local blob: %w", err)
	}
	removeTemporary = false
	return ObjectInfo{
		Key:         key,
		Size:        count,
		Digest:      digest(hash.Sum(nil)),
		ContentType: contentType,
	}, nil
}

func (s *localStore) Open(ctx context.Context, key string) (Object, error) {
	var out Object
	if err := ctx.Err(); err != nil {
		return out, err
	}
	relative, err := s.relativeKey(key)
	if err != nil {
		return out, err
	}
	file, err := s.root.Open(relative)
	if errors.Is(err, os.ErrNotExist) {
		return out, ErrNotFound
	}
	if err != nil {
		return out, fmt.Errorf("open local blob: %w", err)
	}
	info, err := file.Stat()
	if err != nil {
		_ = file.Close()
		return out, fmt.Errorf("stat local blob: %w", err)
	}
	if !info.Mode().IsRegular() {
		_ = file.Close()
		return out, ErrNotFound
	}
	if info.Size() > s.maxBytes {
		_ = file.Close()
		return out, ErrTooLarge
	}
	return Object{
		ObjectInfo: ObjectInfo{Key: key, Size: info.Size()},
		Reader:     file,
	}, nil
}

func (s *localStore) Delete(ctx context.Context, key string) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	relative, err := s.relativeKey(key)
	if err != nil {
		return err
	}
	if err = s.root.Remove(relative); errors.Is(err, os.ErrNotExist) {
		return nil
	}
	return err
}

func (s *localStore) Close() error { return s.root.Close() }

func (s *localStore) relativeKey(key string) (string, error) {
	if err := validateKey(key); err != nil {
		return "", err
	}
	return filepath.FromSlash(key), nil
}

var (
	bucketPattern = regexp.MustCompile(`^[A-Za-z0-9_-]+$`)
	keyPattern    = regexp.MustCompile(`^[A-Za-z0-9._/-]+$`)
)

// NewNATS binds to an existing JetStream Object Store bucket or creates it
// with file-backed JetStream storage when it does not exist.
func NewNATS(ctx context.Context, cfg NATSConfig, limits ...int64) (Store, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	if cfg.Bucket == "" {
		cfg.Bucket = "FLUX_ATTACHMENTS"
	}
	if strings.TrimSpace(cfg.URL) == "" {
		return nil, errors.New("NATS URL is required for the blobstore")
	}
	if !bucketPattern.MatchString(cfg.Bucket) {
		return nil, errors.New("NATS Object Store bucket is invalid")
	}
	maxBytes := boundedMax(limits)
	opts := []nats.Option{
		nats.Name("flux blobstore"),
		nats.Timeout(5 * time.Second),
	}
	if cfg.Credentials != "" {
		opts = append(opts, nats.UserCredentials(cfg.Credentials))
	}
	connection, err := basenats.Dial(cfg.URL, cfg.CertFile, cfg.KeyFile, cfg.CAFile, opts...)
	if err != nil {
		return nil, fmt.Errorf("connect NATS blobstore: %w", err)
	}
	closeConnection := func() { connection.Close() }
	js, err := connection.JetStream()
	if err != nil {
		closeConnection()
		return nil, fmt.Errorf("open NATS JetStream: %w", err)
	}
	objects, err := js.ObjectStore(cfg.Bucket)
	if errors.Is(err, nats.ErrStreamNotFound) {
		objects, err = js.CreateObjectStore(&nats.ObjectStoreConfig{
			Bucket:   cfg.Bucket,
			Storage:  nats.FileStorage,
			Replicas: 1,
		})
		if err != nil {
			// Another instance may have created the bucket between the bind
			// and create calls; bind once more before failing startup.
			if bound, bindErr := js.ObjectStore(cfg.Bucket); bindErr == nil {
				objects, err = bound, nil
			}
		}
	}
	if err != nil {
		closeConnection()
		return nil, fmt.Errorf("open NATS Object Store: %w", err)
	}
	if err = ctx.Err(); err != nil {
		closeConnection()
		return nil, err
	}
	return &natsStore{connection: connection, objects: objects, maxBytes: maxBytes}, nil
}

type natsStore struct {
	connection *nats.Conn
	objects    nats.ObjectStore
	maxBytes   int64
	once       sync.Once
	closeErr   error
}

func (s *natsStore) Put(ctx context.Context, key string, source io.Reader, contentType string) (ObjectInfo, error) {
	var out ObjectInfo
	if err := validateKey(key); err != nil {
		return out, err
	}
	if source == nil {
		return out, errors.New("blob source is nil")
	}
	hash := sha256.New()
	counter := &countingReader{reader: io.LimitReader(&contextReader{ctx: ctx, reader: source}, s.maxBytes+1)}
	meta := &nats.ObjectMeta{Name: key}
	if contentType != "" {
		meta.Headers = nats.Header{"Content-Type": []string{contentType}}
	}
	info, err := s.objects.Put(meta, io.TeeReader(counter, hash), nats.Context(ctx))
	if err != nil {
		_ = s.deleteObject(key)
		return out, err
	}
	if counter.count > s.maxBytes || info.Size > uint64(s.maxBytes) {
		cleanupErr := s.deleteObject(key)
		if cleanupErr != nil {
			return out, errors.Join(ErrTooLarge, cleanupErr)
		}
		return out, ErrTooLarge
	}
	if int64(info.Size) != counter.count {
		_ = s.deleteObject(key)
		return out, errors.New("NATS Object Store returned an inconsistent object size")
	}
	return ObjectInfo{
		Key:         key,
		Size:        int64(info.Size),
		Digest:      digest(hash.Sum(nil)),
		ContentType: contentType,
	}, nil
}

func (s *natsStore) Open(ctx context.Context, key string) (Object, error) {
	var out Object
	if err := validateKey(key); err != nil {
		return out, err
	}
	result, err := s.objects.Get(key, nats.Context(ctx))
	if errors.Is(err, nats.ErrObjectNotFound) {
		return out, ErrNotFound
	}
	if err != nil {
		return out, err
	}
	info, err := result.Info()
	if err != nil {
		_ = result.Close()
		return out, err
	}
	if info.Size > uint64(s.maxBytes) {
		_ = result.Close()
		return out, ErrTooLarge
	}
	return Object{
		ObjectInfo: ObjectInfo{
			Key:         key,
			Size:        int64(info.Size),
			ContentType: info.Headers.Get("Content-Type"),
		},
		Reader: result,
		Verify: result.Error,
	}, nil
}

func (s *natsStore) Delete(ctx context.Context, key string) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	if err := validateKey(key); err != nil {
		return err
	}
	return s.deleteObject(key)
}

func (s *natsStore) deleteObject(key string) error {
	err := s.objects.Delete(key)
	if errors.Is(err, nats.ErrObjectNotFound) {
		return nil
	}
	return err
}

func (s *natsStore) Close() error {
	s.once.Do(func() {
		if s.connection != nil {
			s.connection.Close()
		}
	})
	return s.closeErr
}

func boundedMax(limits []int64) int64 {
	if len(limits) > 0 && limits[0] > 0 && limits[0] < DefaultMaxBytes {
		return limits[0]
	}
	return DefaultMaxBytes
}

func validateKey(key string) error {
	if key == "" || len(key) > 512 || !keyPattern.MatchString(key) ||
		strings.ContainsAny(key, "\\\x00\r\n") || path.IsAbs(key) || path.Clean(key) != key {
		return ErrInvalidKey
	}
	for part := range strings.SplitSeq(key, "/") {
		if part == "" || part == "." || part == ".." {
			return ErrInvalidKey
		}
	}
	return nil
}

func digest(sum []byte) string { return "sha256:" + hex.EncodeToString(sum) }

type contextReader struct {
	ctx    context.Context
	reader io.Reader
}

func (r *contextReader) Read(p []byte) (int, error) {
	if err := r.ctx.Err(); err != nil {
		return 0, err
	}
	return r.reader.Read(p)
}

type countingReader struct {
	reader io.Reader
	count  int64
}

func (r *countingReader) Read(p []byte) (int, error) {
	n, err := r.reader.Read(p)
	r.count += int64(n)
	return n, err
}

var _ Store = (*localStore)(nil)
var _ Store = (*natsStore)(nil)
