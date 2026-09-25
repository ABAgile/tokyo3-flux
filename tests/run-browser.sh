#!/bin/sh
# Runs tests/*.browser.js through playwright-cli against a throwaway Flux: a
# freshly created database, demo login, and the GitLab fixture where needed.
# Nothing outside the created flux_browser_* database is touched.
#
# Usage: tests/run-browser.sh [--soft] [name ...]
#   name     planning, drag-labels, integration, background, proposals or
#            style-snapshot (default: every test except style-snapshot)
#   --soft   record every failed check() instead of stopping at the first;
#            reported stack lines are one past the test file's line numbers
#
# Environment:
#   FLUX_BROWSER_PG     required; URL of any database the role can connect to.
#                       The runner creates and drops a sibling flux_browser_*
#                       database, so the role needs CREATEDB.
#   FLUX_BROWSER_HOST   address the browser uses to reach this machine
#                       (default 127.0.0.1). Demo mode stays loopback-only; a
#                       non-loopback address is served by tests/browser-proxy.mjs
#                       for the duration of each test, so use a private network.
#   FLUX_BROWSER_PORT   base port (default 18190; uses the next one for the proxy)
#   FLUX_BROWSER_OUT    results directory (default: a new temporary directory)
#   PLAYWRIGHT_CLI_SESSION  playwright-cli session (default flux-browser)
#   PLAYWRIGHT_CLI_CONFIG   playwright-cli config (default ~/.playwright/cli.config.json)
set -eu

cd "$(dirname "$0")/.."
ROOT=$(pwd)
SOFT=
if [ "${1:-}" = --soft ]; then SOFT=1; shift; fi
TESTS=${*:-planning drag-labels integration background proposals}
: "${FLUX_BROWSER_PG:?set FLUX_BROWSER_PG to a Postgres URL whose role may create databases}"
HOST=${FLUX_BROWSER_HOST:-127.0.0.1}
PORT=${FLUX_BROWSER_PORT:-18190}
PROXY_PORT=$((PORT + 1))
GITLAB_PORT=8095
OUT=${FLUX_BROWSER_OUT:-$(mktemp -d "${TMPDIR:-/tmp}/flux-browser.XXXXXX")}
SESSION=${PLAYWRIGHT_CLI_SESSION:-flux-browser}
CONFIG=${PLAYWRIGHT_CLI_CONFIG:-$HOME/.playwright/cli.config.json}
mkdir -p "$OUT"
OUT=$(cd "$OUT" && pwd)
PIDS=
DB=

stop() {
  for pid in $PIDS; do kill "$pid" 2>/dev/null || true; done
  for pid in $PIDS; do wait "$pid" 2>/dev/null || true; done
  PIDS=
  if [ -n "$DB" ]; then psql "$FLUX_BROWSER_PG" -qc "DROP DATABASE IF EXISTS $DB WITH (FORCE)" >/dev/null; fi
  DB=
}
trap stop EXIT INT TERM

# playwright-cli writes page snapshots to its working directory, so keep them
# in the results directory rather than the repository.
pw() { (cd "$OUT" && playwright-cli -s="$SESSION" "$@"); }

wait_http() {
  for _ in $(seq 1 50); do
    if node -e "fetch(process.argv[1]).then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))" "$1"; then return 0; fi
    sleep 0.2
  done
  echo "timed out waiting for $1" >&2
  return 1
}

echo "building flux into $OUT"
go build -o "$OUT/flux" ./cmd/flux

run_one() {
  name=$1
  mode=seeded
  gitlab=
  case $name in
    drag-labels) mode=empty ;;
    integration | planning) gitlab=static ;;
    background) gitlab=evolving ;;
    proposals | style-snapshot) ;;
    *) echo "unknown browser test: $name" >&2; return 2 ;;
  esac
  DB="flux_browser_$(date +%s)_$$"
  psql "$FLUX_BROWSER_PG" -qc "CREATE DATABASE $DB" >/dev/null
  db_url=$(printf %s "$FLUX_BROWSER_PG" | sed -E "s#^(postgres(ql)?://[^/]+)/[^?]*#\\1/$DB#")
  log=$OUT/$name.server.log
  (
    export FLUX_DATABASE_URL="$db_url" FLUX_BLOBSTORE=filesystem FLUX_BLOBSTORE_PATH="$OUT/$name.blobs"
    unset FLUX_ADMIN_DATABASE_URL FLUX_SESSION_KEY FLUX_GITLAB_URL FLUX_GITLAB_SERVICE_TOKEN \
      FLUX_GITLAB_WEBHOOK_SECRET FLUX_API_TOKEN FLUX_API_SUBJECT FLUX_NATS_URL
    "$OUT/flux" migrate
    project=
    if [ $mode = seeded ]; then project=Project; fi
    workspace=$("$OUT/flux" bootstrap --name 'Browser test' ${project:+--project "$project"} \
      --subject fixture-user | sed -n 's/.*"id":"\([^"]*\)".*/\1/p')
    # integration expects its seeded work assigned to fixture GitLab user 7.
    seed_subject=fixture-user
    if [ $name = integration ]; then
      seed_subject=7
      "$OUT/flux" member --workspace "$workspace" --subject 7 --role member
    fi
    if [ $mode = seeded ]; then "$OUT/flux" seed --workspace "$workspace" --subject $seed_subject; fi
    if [ $name = proposals ]; then
      "$OUT/flux" member --workspace "$workspace" --subject pi-reader --role viewer
    fi
  ) >"$log" 2>&1

  if [ -n "$gitlab" ]; then
    evolving=
    if [ $gitlab = evolving ]; then evolving=--evolving; fi
    python3 tests/gitlab_fixture.py --port $GITLAB_PORT $evolving >"$OUT/$name.gitlab.log" 2>&1 &
    PIDS="$PIDS $!"
    # Fails if another process already holds the fixture port.
    wait_http "http://127.0.0.1:$GITLAB_PORT/uploads/avatar/7.png"
  fi
  (
    export FLUX_DATABASE_URL="$db_url" FLUX_BLOBSTORE=filesystem FLUX_BLOBSTORE_PATH="$OUT/$name.blobs"
    unset FLUX_ADMIN_DATABASE_URL FLUX_SESSION_KEY FLUX_GITLAB_URL FLUX_GITLAB_SERVICE_TOKEN \
      FLUX_GITLAB_WEBHOOK_SECRET FLUX_API_TOKEN FLUX_API_SUBJECT FLUX_NATS_URL
    export FLUX_GITLAB_REFRESH_INTERVAL=0
    if [ -n "$gitlab" ]; then
      export FLUX_GITLAB_URL=http://127.0.0.1:$GITLAB_PORT FLUX_GITLAB_SERVICE_TOKEN=fixture-read-secret
    fi
    # The idle poll (planning notices, observations) runs only with automatic refresh.
    case $name in background | planning) export FLUX_GITLAB_REFRESH_INTERVAL=30s ;; esac
    if [ $name = background ]; then export FLUX_GITLAB_WEBHOOK_SECRET=fixture-webhook-secret-0000000000000000; fi
    if [ $name = proposals ]; then
      export FLUX_API_TOKEN=fixture-native-machine-token-0000000000 FLUX_API_SUBJECT=pi-reader
    fi
    exec "$OUT/flux" serve --demo --addr "127.0.0.1:$PORT"
  ) >>"$log" 2>&1 &
  PIDS="$PIDS $!"
  wait_http "http://127.0.0.1:$PORT/readyz"
  base=http://127.0.0.1:$PORT
  case $HOST in
    127.0.0.1 | localhost | ::1) ;;
    *)
      node tests/browser-proxy.mjs "$HOST" $PROXY_PORT $PORT &
      PIDS="$PIDS $!"
      base=http://$HOST:$PROXY_PORT
      wait_http "$base/readyz"
      ;;
  esac

  code=$ROOT/tests/$name.browser.js
  if [ -n "$SOFT" ] && [ $name != style-snapshot ]; then
    code=$OUT/$name.soft.js
    node -e '
      const fs = require("node:fs");
      const src = fs.readFileSync(process.argv[1], "utf8").replace(/throw new Error\(message\)/g, "__fails.push(message)");
      fs.writeFileSync(process.argv[2], `async (page) => { const __fails = [];\n${src}\n` +
        "try { const result = await run(page); return JSON.stringify({ fails: __fails, result }); }\n" +
        "catch (error) { return JSON.stringify({ fails: __fails, error: String(error?.message ?? error).split(\"\\n\").slice(0, 3).join(\" | \"), stack: String(error?.stack ?? \"\").split(\"\\n\").filter((l) => /:\\d+:\\d+/.test(l)).slice(0, 4) }); } }\n");
    ' "tests/$name.browser.js" "$code"
  fi
  pw close >/dev/null 2>&1 || true
  pw open "$base/auth/login" --config="$CONFIG" >/dev/null
  pw resize 1440 1000 >/dev/null
  status=0
  pw --raw run-code --filename="$code" >"$OUT/$name.result" 2>&1 || status=$?
  pw close >/dev/null 2>&1 || true
  if [ $status = 0 ] && ! grep -q . "$OUT/$name.result"; then
    # playwright-cli returns without a result when the page opens a native
    # dialog or file chooser; treat that as a failure.
    echo "no result: the page opened a native dialog or file chooser" >"$OUT/$name.result"
    status=1
  fi
  if [ -n "$SOFT" ] && [ $status = 0 ] && [ $name != style-snapshot ]; then
    node -e '
      const fs = require("node:fs");
      let value = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
      if (typeof value === "string") value = JSON.parse(value);
      process.exit(value.fails.length || value.error ? 1 : 0);
    ' "$OUT/$name.result" || status=1
  fi
  if [ $name = style-snapshot ] && [ $status = 0 ]; then
    node -e '
      const fs = require("node:fs");
      let value = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
      if (typeof value === "string") value = JSON.parse(value);
      const lines = [];
      for (const [capture, rows] of Object.entries(value.captures)) lines.push(`=== ${capture} (${rows.length} elements)`, ...rows);
      lines.push("=== styles");
      for (const [key, text] of Object.entries(value.styles)) lines.push(`--- ${key}`, text);
      fs.writeFileSync(process.argv[2], `${lines.join("\n")}\n`);
    ' "$OUT/$name.result" "$OUT/style-snapshot.txt"
    echo "style-snapshot: $OUT/style-snapshot.txt"
  else
    printf '%s: %s\n' "$name" "$(if [ $status = 0 ]; then echo ok; else echo FAILED; fi)"
    sed 's/^/  /' "$OUT/$name.result" | head -c 4000
    echo
  fi
  stop
  return $status
}

failed=
for name in $TESTS; do run_one "$name" || failed="$failed $name"; done
echo "results: $OUT"
if [ -n "$failed" ]; then
  echo "failed:$failed"
  exit 1
fi
