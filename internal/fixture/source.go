// Package fixture provides a file-backed source for local cockpit and Pi
// development without a GitLab connection.
package fixture

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"sort"
	"strconv"
	"strings"
	"time"

	"abagile.com/tokyo3/flux/internal/domain"
	"abagile.com/tokyo3/flux/internal/gitlab"
)

// Source reloads a normalized snapshot from a JSON file for each read. This
// makes editing a fixture followed by Sync now useful during local work.
type Source struct {
	path string
}

// New validates a fixture path without retaining its contents in memory.
func New(path string) (*Source, error) {
	path = strings.TrimSpace(path)
	if path == "" {
		return nil, errors.New("fixture path is required")
	}
	info, err := os.Stat(path)
	if err != nil {
		return nil, fmt.Errorf("stat fixture: %w", err)
	}
	if info.IsDir() {
		return nil, errors.New("fixture path must be a file")
	}
	return &Source{path: path}, nil
}

// Path returns the configured fixture file path.
func (s *Source) Path() string {
	return s.path
}

// Snapshot implements the pull reconciler source.
func (s *Source) Snapshot(ctx context.Context, _ string, goal string) (domain.Snapshot, error) {
	snapshot, err := s.load(ctx)
	if err != nil {
		return domain.Snapshot{}, err
	}
	if strings.TrimSpace(goal) != "" {
		snapshot.Sprint.Goal = strings.TrimSpace(goal)
	}
	if snapshot.GeneratedAt.IsZero() {
		snapshot.GeneratedAt = time.Now().UTC()
	}
	return snapshot, nil
}

// ListMilestones exposes the fixture sprint as one active milestone.
func (s *Source) ListMilestones(ctx context.Context, _ string) ([]domain.Milestone, error) {
	snapshot, err := s.Snapshot(ctx, "", "")
	if err != nil {
		return nil, err
	}
	if strings.TrimSpace(snapshot.Sprint.Name) == "" {
		return []domain.Milestone{}, nil
	}
	return []domain.Milestone{{
		Name:  snapshot.Sprint.Name,
		Goal:  snapshot.Sprint.Goal,
		State: "active",
	}}, nil
}

// SnapshotForMilestone serves the fixture sprint when it is selected.
func (s *Source) SnapshotForMilestone(ctx context.Context, _ string, name, goal string) (domain.Snapshot, error) {
	snapshot, err := s.Snapshot(ctx, "", goal)
	if err != nil {
		return domain.Snapshot{}, err
	}
	if snapshot.Sprint.Name != strings.TrimSpace(name) {
		return domain.Snapshot{}, fmt.Errorf("fixture milestone %q not found", strings.TrimSpace(name))
	}
	return snapshot, nil
}

// GetIssue implements the action reader so the action service can be wired in
// fixture mode. Mutations remain disabled because the fixture has no writer.
func (s *Source) GetIssue(ctx context.Context, projectID, issueIID int) (gitlab.Issue, error) {
	snapshot, err := s.Snapshot(ctx, "", "")
	if err != nil {
		return gitlab.Issue{}, err
	}
	for _, item := range snapshot.Sprint.WorkItems {
		if item.ProjectID != projectID || issueIIDFromID(item.ID) != issueIID {
			continue
		}
		return gitlab.Issue{
			IID:       issueIID,
			ProjectID: projectID,
			Title:     item.Title,
			State:     item.State,
			Labels:    append([]string(nil), item.Labels...),
			UpdatedAt: item.LastActivity,
		}, nil
	}
	return gitlab.Issue{}, fmt.Errorf("fixture issue %d/%d not found", projectID, issueIID)
}

// ListProjectLabels implements the action label reader with labels present in
// the fixture. A fixture has no separate GitLab label catalog.
func (s *Source) ListProjectLabels(ctx context.Context, _ int) ([]string, error) {
	snapshot, err := s.Snapshot(ctx, "", "")
	if err != nil {
		return nil, err
	}
	seen := make(map[string]struct{})
	labels := make([]string, 0)
	for _, item := range snapshot.Sprint.WorkItems {
		for _, label := range item.Labels {
			label = strings.TrimSpace(label)
			if label == "" {
				continue
			}
			if _, ok := seen[label]; ok {
				continue
			}
			seen[label] = struct{}{}
			labels = append(labels, label)
		}
	}
	sort.SliceStable(labels, func(i, j int) bool {
		left, right := strings.ToLower(labels[i]), strings.ToLower(labels[j])
		if left == right {
			return labels[i] < labels[j]
		}
		return left < right
	})
	return labels, nil
}

func (s *Source) load(ctx context.Context) (domain.Snapshot, error) {
	select {
	case <-ctx.Done():
		return domain.Snapshot{}, ctx.Err()
	default:
	}
	data, err := os.ReadFile(s.path)
	if err != nil {
		return domain.Snapshot{}, fmt.Errorf("read fixture: %w", err)
	}
	var snapshot domain.Snapshot
	if err := json.Unmarshal(data, &snapshot); err != nil {
		return domain.Snapshot{}, fmt.Errorf("decode fixture: %w", err)
	}
	return snapshot, nil
}

func issueIIDFromID(id string) int {
	separator := strings.LastIndexByte(id, '#')
	if separator < 0 || separator == len(id)-1 {
		return 0
	}
	iid, err := strconv.Atoi(id[separator+1:])
	if err != nil {
		return 0
	}
	return iid
}
