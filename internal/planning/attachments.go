package planning

import (
	"mime"
	"strings"
	"unicode"
	"unicode/utf8"
)

// ValidAttachmentName reports whether a filename is safe to retain and
// return in a Content-Disposition header. Path components are stripped by the
// HTTP handler before this check.
func ValidAttachmentName(value string) bool {
	if !utf8.ValidString(value) || strings.TrimSpace(value) == "" || len(value) > MaxAttachmentName || value == "." || value == ".." || strings.ContainsAny(value, "/\\") {
		return false
	}
	for _, r := range value {
		if unicode.IsControl(r) || unicode.Is(unicode.Cf, r) {
			return false
		}
	}
	return true
}

// SafeAttachmentMIME reports whether a content type is safe to retain and
// return for a download. Active document and script types are deliberately
// not allowlisted.
func SafeAttachmentMIME(value string) bool {
	mediaType, _, err := mime.ParseMediaType(strings.TrimSpace(value))
	if err != nil || mediaType == "" {
		return false
	}
	_, ok := safeAttachmentMIMEs[mediaType]
	return ok
}

var safeAttachmentMIMEs = map[string]struct{}{
	"application/octet-stream":     {},
	"application/gzip":             {},
	"application/json":             {},
	"application/pdf":              {},
	"application/zip":              {},
	"application/x-7z-compressed":  {},
	"application/x-gzip":           {},
	"application/x-rar-compressed": {},
	"application/x-tar":            {},
	"audio/flac":                   {},
	"audio/mpeg":                   {},
	"audio/ogg":                    {},
	"audio/wav":                    {},
	"audio/wave":                   {},
	"image/avif":                   {},
	"image/bmp":                    {},
	"image/gif":                    {},
	"image/jpeg":                   {},
	"image/png":                    {},
	"image/tiff":                   {},
	"image/webp":                   {},
	"text/csv":                     {},
	"text/markdown":                {},
	"text/plain":                   {},
	"video/mp4":                    {},
	"video/mpeg":                   {},
	"video/ogg":                    {},
	"video/webm":                   {},
}
