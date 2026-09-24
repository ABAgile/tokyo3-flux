package store

import (
	"context"
	"fmt"
	"strings"
	"testing"
)

// The ladder's index must agree with the version each migration declares, so
// Migrate cannot silently skip or replay a step after a file is added.
func TestMigrationLadderMatchesDeclaredVersions(t *testing.T) {
	for i, migration := range migrations {
		want := fmt.Sprintf("UPDATE flux_schema SET version=%d;", i+2)
		if !strings.Contains(migration, want) {
			t.Fatalf("migration %d does not declare %q", i, want)
		}
	}
	if schemaVersion != len(migrations)+1 {
		t.Fatal(schemaVersion)
	}
}

func TestItemDateMigrationFromVersion14(t *testing.T) {
	s := bareStore(t)
	ctx := context.Background()
	execSQL(t, s, schema)
	for _, migration := range migrations[:len(migrations)-1] {
		execSQL(t, s, migration)
	}
	var version int
	if err := s.pool.QueryRow(ctx, "SELECT version FROM flux_schema").Scan(&version); err != nil || version != 14 {
		t.Fatalf("pre-migration version = %d: %v", version, err)
	}
	if err := s.Migrate(ctx); err != nil {
		t.Fatal(err)
	}
	if err := s.Ready(ctx); err != nil {
		t.Fatal(err)
	}
	if err := s.pool.QueryRow(ctx, "SELECT version FROM flux_schema").Scan(&version); err != nil || version != 15 {
		t.Fatalf("post-migration version = %d: %v", version, err)
	}
	var columns int
	if err := s.pool.QueryRow(ctx, `SELECT count(*) FROM information_schema.columns
 WHERE table_schema=current_schema() AND table_name='work_items'
 AND column_name=ANY($1::text[])`, []string{"start_date", "end_date", "due_date"}).Scan(&columns); err != nil || columns != 3 {
		t.Fatalf("item date columns = %d: %v", columns, err)
	}
}

func TestRefreshMigrationPreservesObservations(t *testing.T) {
	s := bareStore(t)
	execSQL(t, s, schema)
	execSQL(t, s, legacyFixture)
	execSQL(t, s, workspaceMigration)
	execSQL(t, s, labelsMigration)
	execSQL(t, s, integrationsMigration)
	execSQL(t, s, `INSERT INTO workspace_integrations VALUES('w','https://gitlab.example'); INSERT INTO approved_gitlab_projects VALUES('w',42); INSERT INTO external_links(workspace_id,id,project_id,kind,number,observation,last_success,outcome) VALUES('w','external',42,'mr',7,'{"head_sha":"original","pipeline":{"id":33,"sha":"original","state":"success","current_head":true}}',now(),'ok'); INSERT INTO item_external_links VALUES('w','a','external')`)
	if err := s.Migrate(context.Background()); err != nil {
		t.Fatal(err)
	}
	if err := s.Migrate(context.Background()); err != nil {
		t.Fatal(err)
	}
	b := getBoard(t, s, "w")
	if len(b.Items) != 3 || b.Workspace.Revision != 9 || len(b.Links) != 1 || b.Links[0].Observation.HeadSHA != "original" || b.Links[0].LastSuccess == nil || !b.Links[0].RefreshPending {
		t.Fatal(b)
	}
}
