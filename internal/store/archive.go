package store

import (
	"context"

	p "abagile.com/tokyo3/flux/internal/planning"
)

// ArchivedItems returns one page of archived work. The board payload carries
// only the live working set, so archived items are read separately and never
// participate in planning writes.
func (s *Store) ArchivedItems(ctx context.Context, wid, subject string, offset, limit int) ([]p.Item, error) {
	if _, err := role(ctx, s.pool, wid, subject); err != nil {
		return nil, err
	}
	if offset < 0 || limit <= 0 || limit > p.ArchivePageLimit {
		return nil, p.ErrInvalid
	}
	rows, err := s.pool.Query(ctx, `SELECT i.id,i.title,i.description,i.column_id,coalesce(i.project_id,''),coalesce(i.assignee,''),i.rank,i.revision,i.archived,
 ARRAY(SELECT p.project_id FROM item_projects p WHERE p.workspace_id=i.workspace_id AND p.item_id=i.id ORDER BY (p.project_id=i.project_id) DESC, p.project_id),
 ARRAY(SELECT label FROM item_labels l WHERE l.workspace_id=i.workspace_id AND l.item_id=i.id ORDER BY label),
 ARRAY(SELECT depends_on FROM dependencies d WHERE d.workspace_id=i.workspace_id AND d.item_id=i.id ORDER BY depends_on),
 ARRAY(SELECT sprint_id FROM item_sprints s WHERE s.workspace_id=i.workspace_id AND s.item_id=i.id ORDER BY sprint_id)
 FROM work_items i WHERE i.workspace_id=$1 AND i.archived ORDER BY i.rank,i.id LIMIT $2 OFFSET $3`, wid, limit, offset)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []p.Item{}
	ids := []string{}
	for rows.Next() {
		var v p.Item
		if err = rows.Scan(&v.ID, &v.Title, &v.Description, &v.ColumnID, &v.ProjectID, &v.Assignee,
			&v.Rank, &v.Revision, &v.Archived, &v.ProjectIDs, &v.Labels, &v.Dependencies, &v.SprintIDs); err != nil {
			return nil, err
		}
		p.NormalizeItemProjects(&v)
		v.Attachments = []p.Attachment{}
		out = append(out, v)
		ids = append(ids, v.ID)
	}
	rows.Close()
	if err = rows.Err(); err != nil {
		return nil, err
	}
	if len(out) == 0 {
		return out, nil
	}
	if err = attachArchivedAttachments(ctx, s, wid, ids, out); err != nil {
		return nil, err
	}
	return out, nil
}

// attachArchivedAttachments loads attachments for exactly the returned page so
// archived cards keep their download links without a per-item query.
func attachArchivedAttachments(ctx context.Context, s *Store, wid string, ids []string, items []p.Item) error {
	indexes := make(map[string]int, len(items))
	for i := range items {
		indexes[items[i].ID] = i
	}
	rows, err := s.pool.Query(ctx, `SELECT id,item_id,storage_key,name,content_type,size,digest,uploader,created_at
 FROM item_attachments WHERE workspace_id=$1 AND item_id=ANY($2::text[]) ORDER BY item_id,id LIMIT $3`,
		wid, ids, p.MaxItemAttachments*len(ids)+1)
	if err != nil {
		return err
	}
	defer rows.Close()
	for rows.Next() {
		var attachment p.Attachment
		if err = rows.Scan(&attachment.ID, &attachment.ItemID, &attachment.StorageKey,
			&attachment.Name, &attachment.ContentType, &attachment.Size, &attachment.Digest,
			&attachment.Uploader, &attachment.CreatedAt); err != nil {
			return err
		}
		index, ok := indexes[attachment.ItemID]
		if !ok || len(items[index].Attachments) >= p.MaxItemAttachments {
			continue
		}
		items[index].Attachments = append(items[index].Attachments, attachment)
	}
	return rows.Err()
}
