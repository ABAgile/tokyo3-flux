package planning

import "testing"

func TestValidAttachmentName(t *testing.T) {
	for _, value := range []string{"note.txt", "résumé.pdf", "file name.md"} {
		if !ValidAttachmentName(value) {
			t.Errorf("rejected valid filename %q", value)
		}
	}
	for _, value := range []string{"", ".", "..", "../note.txt", "note\\\\txt", "line\nfeed", "hidden\u202eexe"} {
		if ValidAttachmentName(value) {
			t.Errorf("accepted unsafe filename %q", value)
		}
	}
}

func TestSafeAttachmentMIME(t *testing.T) {
	for _, value := range []string{"text/plain", "text/markdown; charset=utf-8", "application/pdf", "image/png"} {
		if !SafeAttachmentMIME(value) {
			t.Errorf("rejected safe MIME %q", value)
		}
	}
	for _, value := range []string{"text/html", "text/javascript", "application/javascript", "image/svg+xml", "not-a-MIME"} {
		if SafeAttachmentMIME(value) {
			t.Errorf("accepted unsafe MIME %q", value)
		}
	}
	for _, supplied := range []string{"", "application/octet-stream", "text/html"} {
		if got := attachmentContentType(supplied, []byte("<html><script>bad()</script></html>")); !SafeAttachmentMIME(got) {
			t.Errorf("unsafe detected MIME %q from %q", got, supplied)
		}
	}
}
