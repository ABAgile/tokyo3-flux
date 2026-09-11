package store

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"strings"

	p "abagile.com/tokyo3/flux/internal/planning"
	"github.com/jackc/pgx/v5"
)

func validCommentItemID(itemID string) bool {
	return itemID != "" && len(itemID) <= 240 && !strings.ContainsAny(itemID, "\r\n")
}

func commentDigest(itemID, body string) string {
	sum := sha256.Sum256([]byte(itemID + "\x00" + body))
	return hex.EncodeToString(sum[:])
}

// Comments returns the append-only item discussion without loading it into the
// planning board or its revision-checked snapshots.
func (s *Store) Comments(ctx context.Context, wid, subject, itemID string) ([]p.Comment, error) {
	if !validCommentItemID(itemID) {
		return nil, p.ErrInvalid
	}
	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.RepeatableRead, AccessMode: pgx.ReadOnly})
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err = role(ctx, tx, wid, subject); err != nil {
		return nil, err
	}
	var exists bool
	if err = tx.QueryRow(ctx, "SELECT EXISTS (SELECT 1 FROM work_items WHERE workspace_id=$1 AND id=$2)", wid, itemID).Scan(&exists); err != nil {
		return nil, err
	}
	if !exists {
		return nil, p.ErrNotFound
	}
	rows, err := tx.Query(ctx, `SELECT id,item_id,author,body,created_at
 FROM item_comments WHERE workspace_id=$1 AND item_id=$2 ORDER BY id LIMIT $3`, wid, itemID, p.MaxItemComments)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	comments := make([]p.Comment, 0)
	for rows.Next() {
		var comment p.Comment
		if err = rows.Scan(&comment.ID, &comment.ItemID, &comment.Author, &comment.Body, &comment.CreatedAt); err != nil {
			return nil, err
		}
		comments = append(comments, comment)
	}
	if err = rows.Err(); err != nil {
		return nil, err
	}
	if err = tx.Commit(ctx); err != nil {
		return nil, err
	}
	return comments, nil
}

// AddComment appends one immutable comment. It intentionally does not lock or
// update workspace planning revision, audit events, or burn-down snapshots.
func (s *Store) AddComment(ctx context.Context, wid, subject, itemID, key, body string) (p.Comment, error) {
	var comment p.Comment
	if !validCommentItemID(itemID) {
		return comment, p.ErrInvalid
	}
	if len(key) < 16 || len(key) > 120 || strings.ContainsAny(key, "\r\n") {
		return comment, fmtCommentInvalid("Idempotency-Key must be 16–120 characters")
	}
	body = strings.TrimSpace(body)
	if body == "" || len(body) > p.MaxCommentLength || strings.ContainsRune(body, '\x00') {
		return comment, fmtCommentInvalid("comment must be 1–4000 bytes")
	}
	digest := commentDigest(itemID, body)
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return comment, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var memberRole string
	err = tx.QueryRow(ctx, "SELECT role FROM memberships WHERE workspace_id=$1 AND subject=$2 FOR SHARE", wid, subject).Scan(&memberRole)
	if errors.Is(err, pgx.ErrNoRows) {
		return comment, p.ErrForbidden
	}
	if err != nil {
		return comment, err
	}
	if memberRole != "member" && memberRole != "admin" {
		return comment, p.ErrForbidden
	}
	var exists bool
	if err = tx.QueryRow(ctx, "SELECT EXISTS (SELECT 1 FROM work_items WHERE workspace_id=$1 AND id=$2)", wid, itemID).Scan(&exists); err != nil {
		return comment, err
	}
	if !exists {
		return comment, p.ErrNotFound
	}
	err = tx.QueryRow(ctx, `INSERT INTO item_comments(workspace_id,item_id,author,body,idempotency_key,digest)
 VALUES($1,$2,$3,$4,$5,$6)
 ON CONFLICT (workspace_id,author,idempotency_key) DO NOTHING
 RETURNING id,item_id,author,body,created_at`, wid, itemID, subject, body, key, digest).
		Scan(&comment.ID, &comment.ItemID, &comment.Author, &comment.Body, &comment.CreatedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		var existingDigest string
		err = tx.QueryRow(ctx, `SELECT id,item_id,author,body,created_at,digest
 FROM item_comments WHERE workspace_id=$1 AND author=$2 AND idempotency_key=$3`, wid, subject, key).
			Scan(&comment.ID, &comment.ItemID, &comment.Author, &comment.Body, &comment.CreatedAt, &existingDigest)
		if errors.Is(err, pgx.ErrNoRows) {
			return p.Comment{}, p.ErrConflict
		}
		if err != nil {
			return p.Comment{}, err
		}
		if existingDigest != digest {
			return p.Comment{}, p.ErrConflict
		}
	} else if err != nil {
		return p.Comment{}, err
	}
	if err = tx.Commit(ctx); err != nil {
		return p.Comment{}, err
	}
	return comment, nil
}

func fmtCommentInvalid(message string) error {
	return fmt.Errorf("%w: %s", p.ErrInvalid, message)
}
