package store

import (
	"context"
	"testing"
)

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
