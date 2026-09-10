package store

import (
	"context"
	"errors"
	"slices"
	"testing"

	p "abagile.com/tokyo3/flux/internal/planning"
)

func TestLabelsAndNamesPersist(t *testing.T) {
	s := testStore(t)
	b := bootstrap(t, s)
	ctx := context.Background()
	it := newItem(b, "Labeled item")
	apply(t, s, &b, p.Command{Kind: "item.create", Item: &it})
	apply(t, s, &b, p.Command{Kind: "item.archive", Target: b.Items[0].ID})
	apply(t, s, &b, p.Command{Kind: "label.save", Target: "native", Name: "type::planning", Color: "#ffcc00"})
	if len(b.Labels) != 1 || b.Labels[0].Name != "type::planning" || b.Labels[0].Color != "#ffcc00" || !slices.Equal(b.Items[0].Labels, []string{"type::planning"}) {
		t.Fatal(b)
	}
	apply(t, s, &b, p.Command{Kind: "member.name", Target: "alice", Name: "Alice Example"})
	if b.Members[0].Name != "Alice Example" || b.Items[0].Assignee != "alice" {
		t.Fatal(b)
	}
	if err := s.SetMember(ctx, b.Workspace.ID, "bob", "member"); err != nil {
		t.Fatal(err)
	}
	if _, err := s.Change(ctx, b.Workspace.ID, "bob", p.NewID(), p.Command{Kind: "member.name", Target: "alice", Name: "Spoof", Revision: b.Workspace.Revision}); !errors.Is(err, p.ErrForbidden) {
		t.Fatal(err)
	}
	apply(t, s, &b, p.Command{Kind: "label.delete", Target: "type::planning"})
	if len(b.Labels) != 0 || len(b.Items[0].Labels) != 0 {
		t.Fatal(b)
	}
}

func TestLabelsMigrationFromSchema2(t *testing.T) {
	s := bareStore(t)
	ctx := context.Background()
	execSQL(t, s, schema)
	execSQL(t, s, legacyFixture)
	execSQL(t, s, workspaceMigration)
	execSQL(t, s, `INSERT INTO item_labels(workspace_id,item_id,label) VALUES('w','c','archived label')`)
	if err := s.Migrate(ctx); err != nil {
		t.Fatal(err)
	}
	if err := s.Migrate(ctx); err != nil {
		t.Fatal(err)
	}
	b := getBoard(t, s, "w")
	if len(b.Labels) != 5 || b.Labels[0].Name != "archived label" || b.Labels[1].Name != "native" || b.Labels[2].Name != "priority::high" || b.Labels[3].Name != "priority::low" || b.Labels[4].Name != "priority::normal" || b.Labels[0].Color != p.DefaultLabelColor || b.Labels[1].Color != p.DefaultLabelColor || len(b.Items) != 3 || b.Workspace.Revision != 9 {
		t.Fatal(b)
	}
	if _, err := s.pool.Exec(ctx, `INSERT INTO item_labels(workspace_id,item_id,label) VALUES('w','a','unknown')`); err == nil {
		t.Fatal("accepted label outside workspace catalog")
	}
}

func TestLabelAndNameAuditRollback(t *testing.T) {
	for _, kind := range []string{"label.save", "member.name"} {
		t.Run(kind, func(t *testing.T) {
			s := testStore(t)
			b := bootstrap(t, s)
			execSQL(t, s, `CREATE FUNCTION reject_new_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'audit unavailable'; END $$; CREATE TRIGGER reject_audit BEFORE INSERT ON audit_events FOR EACH ROW EXECUTE FUNCTION reject_new_audit()`)
			c := p.Command{Kind: kind, Name: "New name", Revision: b.Workspace.Revision}
			if kind == "member.name" {
				c.Target = "alice"
			}
			if _, err := s.Change(context.Background(), b.Workspace.ID, "alice", p.NewID(), c); err == nil {
				t.Fatal("accepted failed audit")
			}
			next := getBoard(t, s, b.Workspace.ID)
			if next.Workspace.Revision != b.Workspace.Revision || len(next.Labels) != 0 || next.Members[0].Name != "" {
				t.Fatal(next)
			}
		})
	}
}
