package store

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"mime"
	"path"
	"strings"

	p "abagile.com/tokyo3/flux/internal/planning"
	"github.com/jackc/pgx/v5"
)

func validAttachmentItemID(itemID string) bool {
	return itemID != "" && len(itemID) <= 240 && !strings.ContainsAny(itemID, "\r\n")
}

func validAttachmentID(id int64) bool { return id > 0 }

func validAttachmentStorageKey(key string) bool {
	if key == "" || len(key) > 512 || strings.ContainsAny(key, "\\\x00\r\n") ||
		path.IsAbs(key) || path.Clean(key) != key {
		return false
	}
	for part := range strings.SplitSeq(key, "/") {
		if part == "" || part == "." || part == ".." {
			return false
		}
	}
	for _, character := range key {
		if (character < 'a' || character > 'z') && (character < 'A' || character > 'Z') &&
			(character < '0' || character > '9') && !strings.ContainsRune("._/-", character) {
			return false
		}
	}
	return true
}

func validAttachmentIdempotencyKey(key string) bool {
	return len(key) >= 16 && len(key) <= 120 && !strings.ContainsAny(key, "\x00\r\n")
}

func validateAttachmentMetadata(attachment p.Attachment) error {
	if !p.ValidAttachmentName(attachment.Name) {
		return fmt.Errorf("%w: attachment name must be 1–255 bytes", p.ErrInvalid)
	}
	mediaType, _, mediaErr := mime.ParseMediaType(attachment.ContentType)
	if mediaErr != nil || mediaType == "" || len(mediaType) > p.MaxAttachmentMIME ||
		!p.SafeAttachmentMIME(mediaType) || strings.ContainsRune(attachment.ContentType, '\x00') ||
		strings.ContainsAny(attachment.ContentType, "\r\n") {
		return fmt.Errorf("%w: attachment content type is invalid", p.ErrInvalid)
	}
	if attachment.Size < 0 || attachment.Size > p.MaxAttachmentBytes {
		return fmt.Errorf("%w: attachment exceeds the 20 MiB size limit", p.ErrInvalid)
	}
	if len(attachment.Digest) != len("sha256:")+sha256.Size*2 ||
		!strings.HasPrefix(attachment.Digest, "sha256:") {
		return fmt.Errorf("%w: attachment digest is invalid", p.ErrInvalid)
	}
	digestHex := attachment.Digest[len("sha256:"):]
	if digestHex != strings.ToLower(digestHex) {
		return fmt.Errorf("%w: attachment digest is invalid", p.ErrInvalid)
	}
	if _, err := hex.DecodeString(digestHex); err != nil {
		return fmt.Errorf("%w: attachment digest is invalid", p.ErrInvalid)
	}
	return nil
}

const attachmentColumns = `id,item_id,storage_key,name,content_type,size,digest,uploader,created_at`

func scanAttachment(row pgx.Row, attachment *p.Attachment) error {
	return row.Scan(&attachment.ID, &attachment.ItemID, &attachment.StorageKey,
		&attachment.Name, &attachment.ContentType, &attachment.Size, &attachment.Digest,
		&attachment.Uploader, &attachment.CreatedAt)
}

// Attachment returns metadata only after checking workspace membership. The
// storage key is kept in the in-process value but excluded from JSON.
func (s *Store) Attachment(ctx context.Context, wid, subject, itemID string, id int64) (p.Attachment, error) {
	var attachment p.Attachment
	if !validAttachmentItemID(itemID) || !validAttachmentID(id) {
		return attachment, p.ErrInvalid
	}
	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{
		IsoLevel:   pgx.RepeatableRead,
		AccessMode: pgx.ReadOnly,
	})
	if err != nil {
		return attachment, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err = role(ctx, tx, wid, subject); err != nil {
		return attachment, err
	}
	query := "SELECT " + attachmentColumns +
		" FROM item_attachments WHERE workspace_id=$1 AND item_id=$2 AND id=$3"
	if err = scanAttachment(tx.QueryRow(ctx, query, wid, itemID, id), &attachment); errors.Is(err, pgx.ErrNoRows) {
		return p.Attachment{}, p.ErrNotFound
	} else if err != nil {
		return p.Attachment{}, err
	}
	if err = tx.Commit(ctx); err != nil {
		return p.Attachment{}, err
	}
	return attachment, nil
}

// AddAttachment records metadata after the blob has been uploaded. It does
// not change the planning revision; attachment lifecycle is audited separately
// from revisioned card state. The idempotency key makes retried multipart
// requests return the original metadata instead of creating a duplicate.
func (s *Store) AddAttachment(ctx context.Context, wid, subject, itemID, key,
	idempotencyKey string, attachment p.Attachment) (p.Attachment, error) {
	if !validAttachmentItemID(itemID) || !validAttachmentStorageKey(key) ||
		!validAttachmentIdempotencyKey(idempotencyKey) {
		return p.Attachment{}, fmt.Errorf("%w: invalid attachment identity", p.ErrInvalid)
	}
	attachment.Name = strings.TrimSpace(attachment.Name)
	if mediaType, _, mediaErr := mime.ParseMediaType(attachment.ContentType); mediaErr == nil {
		attachment.ContentType = mediaType
	}
	if err := validateAttachmentMetadata(attachment); err != nil {
		return p.Attachment{}, err
	}
	if attachment.ItemID != "" && attachment.ItemID != itemID {
		return p.Attachment{}, fmt.Errorf("%w: attachment item cannot be changed", p.ErrInvalid)
	}

	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return p.Attachment{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var workspaceID string
	if err = tx.QueryRow(ctx, "SELECT id FROM workspaces WHERE id=$1 FOR UPDATE", wid).Scan(&workspaceID); errors.Is(err, pgx.ErrNoRows) {
		return p.Attachment{}, p.ErrNotFound
	} else if err != nil {
		return p.Attachment{}, err
	}
	var memberRole string
	if err = tx.QueryRow(ctx, "SELECT role FROM memberships WHERE workspace_id=$1 AND subject=$2 FOR SHARE", wid, subject).Scan(&memberRole); errors.Is(err, pgx.ErrNoRows) {
		return p.Attachment{}, p.ErrForbidden
	} else if err != nil {
		return p.Attachment{}, err
	}
	if memberRole != "member" && memberRole != "admin" {
		return p.Attachment{}, p.ErrForbidden
	}
	var existing p.Attachment
	query := "SELECT " + attachmentColumns +
		" FROM item_attachments WHERE workspace_id=$1 AND uploader=$2 AND idempotency_key=$3"
	err = scanAttachment(tx.QueryRow(ctx, query, wid, subject, idempotencyKey), &existing)
	if err == nil {
		if existing.Name != attachment.Name || existing.ContentType != attachment.ContentType ||
			existing.Size != attachment.Size || existing.Digest != attachment.Digest ||
			existing.ItemID != itemID {
			return p.Attachment{}, p.ErrConflict
		}
		if err = tx.Commit(ctx); err != nil {
			return p.Attachment{}, err
		}
		return existing, nil
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return p.Attachment{}, err
	}
	var archived bool
	if err = tx.QueryRow(ctx, "SELECT archived FROM work_items WHERE workspace_id=$1 AND id=$2 FOR SHARE", wid, itemID).Scan(&archived); errors.Is(err, pgx.ErrNoRows) {
		return p.Attachment{}, p.ErrNotFound
	} else if err != nil {
		return p.Attachment{}, err
	}
	if archived {
		return p.Attachment{}, fmt.Errorf("%w: restore an archived item before adding attachments", p.ErrInvalid)
	}
	var count int
	if err = tx.QueryRow(ctx, "SELECT count(*) FROM item_attachments WHERE workspace_id=$1 AND item_id=$2", wid, itemID).Scan(&count); err != nil {
		return p.Attachment{}, err
	}
	if count >= p.MaxItemAttachments {
		return p.Attachment{}, fmt.Errorf("%w: maximum 100 attachments per card", p.ErrInvalid)
	}
	var workspaceCount int
	if err = tx.QueryRow(ctx, "SELECT count(*) FROM item_attachments WHERE workspace_id=$1", wid).Scan(&workspaceCount); err != nil {
		return p.Attachment{}, err
	}
	if workspaceCount >= p.MaxWorkspaceAttachments {
		return p.Attachment{}, fmt.Errorf("%w: maximum 10000 attachments per workspace", p.ErrInvalid)
	}
	attachment.ItemID = itemID
	attachment.Uploader = subject
	attachment.StorageKey = key
	if err = scanAttachment(tx.QueryRow(ctx, `INSERT INTO item_attachments
 (workspace_id,item_id,storage_key,name,content_type,size,digest,uploader,idempotency_key)
 VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)
 RETURNING `+attachmentColumns, wid, itemID, key, attachment.Name, attachment.ContentType,
		attachment.Size, attachment.Digest, subject, idempotencyKey), &attachment); err != nil {
		return p.Attachment{}, err
	}
	after, err := json.Marshal(attachment)
	if err != nil {
		return p.Attachment{}, err
	}
	if _, err = tx.Exec(ctx, `INSERT INTO audit_events
 (workspace_id,actor,action,request_id,before_state,after_state,outcome)
 VALUES($1,$2,'item.attachment.add',$3,NULL,$4,'success')`, wid, subject, idempotencyKey, after); err != nil {
		return p.Attachment{}, err
	}
	if err = tx.Commit(ctx); err != nil {
		return p.Attachment{}, err
	}
	return attachment, nil
}

// RemoveAttachment removes metadata and returns the generated blob key. The
// caller deletes the bytes after this transaction commits.
func (s *Store) RemoveAttachment(ctx context.Context, wid, subject, itemID string, id int64) (p.Attachment, error) {
	var attachment p.Attachment
	if !validAttachmentItemID(itemID) || !validAttachmentID(id) {
		return attachment, p.ErrInvalid
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return attachment, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var workspaceID string
	if err = tx.QueryRow(ctx, "SELECT id FROM workspaces WHERE id=$1 FOR UPDATE", wid).Scan(&workspaceID); errors.Is(err, pgx.ErrNoRows) {
		return p.Attachment{}, p.ErrNotFound
	} else if err != nil {
		return p.Attachment{}, err
	}
	var memberRole string
	if err = tx.QueryRow(ctx, "SELECT role FROM memberships WHERE workspace_id=$1 AND subject=$2 FOR SHARE", wid, subject).Scan(&memberRole); errors.Is(err, pgx.ErrNoRows) {
		return p.Attachment{}, p.ErrForbidden
	} else if err != nil {
		return p.Attachment{}, err
	}
	if memberRole != "member" && memberRole != "admin" {
		return p.Attachment{}, p.ErrForbidden
	}
	query := "SELECT " + attachmentColumns +
		" FROM item_attachments WHERE workspace_id=$1 AND item_id=$2 AND id=$3 FOR UPDATE"
	if err = scanAttachment(tx.QueryRow(ctx, query, wid, itemID, id), &attachment); errors.Is(err, pgx.ErrNoRows) {
		return p.Attachment{}, p.ErrNotFound
	} else if err != nil {
		return p.Attachment{}, err
	}
	var archived bool
	if err = tx.QueryRow(ctx, "SELECT archived FROM work_items WHERE workspace_id=$1 AND id=$2 FOR SHARE", wid, itemID).Scan(&archived); errors.Is(err, pgx.ErrNoRows) {
		return p.Attachment{}, p.ErrNotFound
	} else if err != nil {
		return p.Attachment{}, err
	}
	if archived {
		return p.Attachment{}, fmt.Errorf("%w: restore an archived item before removing attachments", p.ErrInvalid)
	}
	if _, err = tx.Exec(ctx, "DELETE FROM item_attachments WHERE workspace_id=$1 AND id=$2", wid, id); err != nil {
		return p.Attachment{}, err
	}
	after, err := json.Marshal(attachment)
	if err != nil {
		return p.Attachment{}, err
	}
	if _, err = tx.Exec(ctx, `INSERT INTO audit_events
 (workspace_id,actor,action,request_id,before_state,after_state,outcome)
 VALUES($1,$2,'item.attachment.remove',$3,$4,NULL,'success')`, wid, subject, p.NewID(), after); err != nil {
		return p.Attachment{}, err
	}
	if err = tx.Commit(ctx); err != nil {
		return p.Attachment{}, err
	}
	return attachment, nil
}
