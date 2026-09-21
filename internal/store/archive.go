package store

import (
	"context"
	"errors"

	p "abagile.com/tokyo3/flux/internal/planning"
)

// itemColumns is the single work-item projection shared by the archive page
// and the single-card read, so a shared link renders exactly what the archive
// list would render.
const itemColumns = `i.id,i.title,i.description,i.column_id,coalesce(i.project_id,''),coalesce(i.assignee,''),i.rank,i.revision,i.archived,
 ARRAY(SELECT p.project_id FROM item_projects p WHERE p.workspace_id=i.workspace_id AND p.item_id=i.id ORDER BY (p.project_id=i.project_id) DESC, p.project_id),
 ARRAY(SELECT label FROM item_labels l WHERE l.workspace_id=i.workspace_id AND l.item_id=i.id ORDER BY label),
 ARRAY(SELECT depends_on FROM dependencies d WHERE d.workspace_id=i.workspace_id AND d.item_id=i.id ORDER BY depends_on),
 ARRAY(SELECT sprint_id FROM item_sprints s WHERE s.workspace_id=i.workspace_id AND s.item_id=i.id ORDER BY sprint_id)`

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
	rows, err := s.pool.Query(ctx, "SELECT "+itemColumns+
		" FROM work_items i WHERE i.workspace_id=$1 AND i.archived ORDER BY i.rank,i.id LIMIT $2 OFFSET $3", wid, limit, offset)
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
	if err = attachItemAttachments(ctx, s, wid, ids, out); err != nil {
		return nil, err
	}
	return out, nil
}

// attachItemAttachments loads attachments for exactly the items read so
// archived cards keep their download links without a per-item query. Rows pass
// the same integrity gate the per-card read applies, so an archived card never
// advertises a download the transfer path would refuse.
func attachItemAttachments(ctx context.Context, s *Store, wid string, ids []string, items []p.Item) error {
	indexes := make(map[string]int, len(items))
	for i := range items {
		indexes[items[i].ID] = i
	}
	rows, err := s.pool.Query(ctx, "SELECT "+attachmentColumns+
		" FROM item_attachments WHERE workspace_id=$1 AND item_id=ANY($2::text[]) ORDER BY item_id,id LIMIT $3",
		wid, ids, p.MaxItemAttachments*len(ids)+1)
	if err != nil {
		return err
	}
	defer rows.Close()
	for rows.Next() {
		var attachment p.Attachment
		if err = scanAttachment(rows, &attachment); err != nil {
			return err
		}
		if checkStoredAttachment(attachment) != nil {
			return errors.New("archived card contains invalid attachment metadata")
		}
		index, ok := indexes[attachment.ItemID]
		if !ok || len(items[index].Attachments) >= p.MaxItemAttachments {
			continue
		}
		items[index].Attachments = append(items[index].Attachments, attachment)
		items[index].AttachmentCount = len(items[index].Attachments)
	}
	return rows.Err()
}
