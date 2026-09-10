package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"strconv"
	"strings"
	"time"

	p "abagile.com/tokyo3/flux/internal/planning"
)

func fetchNative(path string) ([]byte, error) {
	u, err := url.Parse(os.Getenv("FLUX_API_URL"))
	token := os.Getenv("FLUX_API_TOKEN")
	if err != nil || u.Host == "" || u.User != nil || u.RawQuery != "" || u.Fragment != "" || u.Path != "" && u.Path != "/" || token == "" {
		return nil, errors.New("FLUX_API_URL (origin) and FLUX_API_TOKEN are required")
	}
	ip := net.ParseIP(u.Hostname())
	loopback := u.Hostname() == "localhost" || (ip != nil && ip.IsLoopback())
	if u.Scheme != "https" && !(u.Scheme == "http" && loopback) {
		return nil, errors.New("native API requires HTTPS except loopback fixtures")
	}
	request, err := http.NewRequest(http.MethodGet, strings.TrimRight(u.String(), "/")+path, nil)
	if err != nil {
		return nil, err
	}
	request.Header.Set("Authorization", "Bearer "+token)
	request.Header.Set("Accept", "application/json")
	client := http.Client{Timeout: 15 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	response, err := client.Do(request)
	if err != nil {
		return nil, errors.New("native API request failed")
	}
	defer response.Body.Close()
	if response.StatusCode != 200 {
		return nil, fmt.Errorf("native API returned HTTP %d; check membership, revision and configuration", response.StatusCode)
	}
	data, err := io.ReadAll(io.LimitReader(response.Body, (32<<20)+1))
	if err != nil || len(data) > 32<<20 {
		return nil, errors.New("native API response exceeded limit or could not be read")
	}
	return data, nil
}
func runRead(args []string, stdout, stderr io.Writer) error {
	f := flag.NewFlagSet("read", flag.ContinueOnError)
	f.SetOutput(stderr)
	workspace := f.String("workspace", os.Getenv("FLUX_WORKSPACE"), "explicit workspace ID")
	view := f.String("view", "board", "native read model")
	target := f.String("target", "", "native item ID")
	offset := f.Int("offset", 0, "page offset (history uses event ID before)")
	revision := f.Int64("revision", 0, "planning revision required after first page")
	limit := f.Int("limit", 20, "1–50 records")
	if err := f.Parse(args); err != nil {
		return err
	}
	if *workspace == "" || f.NArg() != 0 {
		return errors.New("read requires --workspace ID and flags only")
	}
	root := "/api/v2/workspaces/" + url.PathEscape(*workspace)
	path := root + "/read/" + url.PathEscape(*view) + "?" + url.Values{"target": {*target}, "offset": {strconv.Itoa(*offset)}, "revision": {strconv.FormatInt(*revision, 10)}, "limit": {strconv.Itoa(*limit)}}.Encode()
	if *view == "history" {
		path = root + "/history?before=" + strconv.Itoa(*offset)
	}
	raw, err := fetchNative(path)
	if err != nil {
		return err
	}
	_, err = stdout.Write(raw)
	return err
}
func readJSONFile(path string, value any, strict bool) error {
	file, err := os.Open(path)
	if err != nil {
		return errors.New("cannot open import input")
	}
	defer file.Close()
	raw, err := io.ReadAll(io.LimitReader(file, (1<<20)+1))
	if err != nil || len(raw) > 1<<20 {
		return errors.New("import file exceeds one MiB or could not be read")
	}
	dec := json.NewDecoder(bytes.NewReader(raw))
	if strict {
		dec.DisallowUnknownFields()
	}
	if err = dec.Decode(value); err != nil {
		return errors.New("invalid import JSON")
	}
	if dec.Decode(new(any)) != io.EOF {
		return errors.New("trailing import JSON")
	}
	return nil
}
func runImport(args []string, stdout, stderr io.Writer) error {
	f := flag.NewFlagSet("import", flag.ContinueOnError)
	f.SetOutput(stderr)
	input := f.String("input", "", "snapshot file")
	mapping := f.String("mapping", "", "explicit mapping file")
	wid := f.String("workspace", os.Getenv("FLUX_WORKSPACE"), "destination workspace")
	if err := f.Parse(args); err != nil {
		return err
	}
	if *input == "" || *mapping == "" || *wid == "" || f.NArg() != 0 {
		return errors.New("import requires --workspace ID --input FILE --mapping FILE; dry run only")
	}
	var snapshot p.Snapshot
	var mappings p.ImportMapping
	if err := readJSONFile(*input, &snapshot, false); err != nil {
		return err
	}
	if err := readJSONFile(*mapping, &mappings, true); err != nil {
		return err
	}
	raw, err := fetchNative("/api/v2/workspaces/" + url.PathEscape(*wid) + "/board")
	if err != nil {
		return err
	}
	var b p.Board
	if err = json.Unmarshal(raw, &b); err != nil {
		return errors.New("invalid native board response")
	}
	report := p.CompileImport(snapshot, mappings, *wid, b.Workspace.Revision)
	if report.Document != nil {
		v := p.Proposal{Document: *report.Document}
		for range v.Document.Imports {
			v.NativeIDs = append(v.NativeIDs, p.NewID())
		}
		skipped := map[string]string{}
		for _, r := range b.Imported {
			for _, entry := range v.Document.Imports {
				if entry.Source == r.Source {
					skipped[r.Source] = r.ItemID
				}
			}
		}
		var preview p.ProposalPreview
		if _, preview, err = p.PreviewProposal(b, v, skipped); err != nil {
			report.Unresolved = append(report.Unresolved, err.Error())
			report.Document = nil
		}
		if report.Document != nil {
			report.AlreadyImported = len(preview.Skipped)
			report.WouldCreate = preview.Created
		}
		if data, _ := json.Marshal(report.Document); len(data) > 56<<10 {
			report.Unresolved = append(report.Unresolved, "Document exceeds 56 KiB; split into smaller batches")
			report.Document = nil
		}
	}
	return json.NewEncoder(stdout).Encode(report)
}
