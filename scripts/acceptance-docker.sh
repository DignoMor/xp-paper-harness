#!/usr/bin/env bash
# Requires Docker Compose >= 2.24.4 (!override), curl, Node, and npm ci on host.
# Runs against disposable Library data and an offline provider fixture.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
PORT="${PAPER_HARNESS_ACCEPTANCE_PORT:-18787}"
WORK_DIR="$(mktemp -d "${TMPDIR:-/tmp}/paper-harness-acceptance.XXXXXX")"
DATA_DIR="$WORK_DIR/library"
PROJECT="paper-harness-acceptance-$$"
mkdir "$DATA_DIR"
# The runtime's unprivileged node user must be able to write the bind mount.
chmod 777 "$DATA_DIR"
ENV_FILE="$WORK_DIR/acceptance.env"
cat > "$ENV_FILE" <<EOF_ENV
PAPER_HARNESS_HOST_DATA_DIR=$DATA_DIR
LLM_PROVIDER=opencode-go
OPENCODE_GO_API_KEY=offline-acceptance-fixture
OPENCODE_GO_BASE_URL=http://fixture-provider:9999/v1
EOF_ENV
cat > "$WORK_DIR/override.yml" <<EOF_COMPOSE
services:
  paper-harness:
    image: $PROJECT:v1
    env_file: !override
      - $ENV_FILE
    ports: !override
      - "127.0.0.1:$PORT:8787"
    depends_on:
      - fixture-provider
  fixture-provider:
    image: $PROJECT:v1
    command: ["node", "/fixtures/provider.mjs"]
    volumes:
      - $ROOT/scripts/acceptance-provider.mjs:/fixtures/provider.mjs:ro
EOF_COMPOSE
compose() { docker compose --env-file "$ENV_FILE" -p "$PROJECT" -f "$ROOT/docker-compose.yml" -f "$WORK_DIR/override.yml" "$@"; }
cleanup() {
  compose down -v --remove-orphans >/dev/null 2>&1 || true
  rm -rf "$WORK_DIR"
}
trap cleanup EXIT
fail() { echo "FAIL: $*" >&2; exit 1; }
pass() { echo "PASS: $*"; }
compose up --build -d
for _ in $(seq 1 90); do
  if curl -fsS "http://127.0.0.1:$PORT/api/health" >/dev/null 2>&1; then break; fi
  sleep 2
done
BASE="http://127.0.0.1:$PORT"
curl -fsS "$BASE/api/health" >/dev/null || fail "health endpoint never became ready"
PUBLISHED="$(compose port paper-harness 8787)"
[[ "$PUBLISHED" == "127.0.0.1:$PORT" ]] || fail "port is not loopback-only: $PUBLISHED"
pass "loopback publication"

CONV_ID="$(curl -fsS -X POST "$BASE/api/conversations" -H 'content-type: application/json' -d '{}' | node -e 'let s=""; for await (const c of process.stdin) s+=c; process.stdout.write(JSON.parse(s).conversation_id)' --input-type=module)"
# A genuine, extractable, three-page PDF, not just a PDF signature.
node --import tsx --input-type=module -e 'import {writeFileSync} from "node:fs"; import {buildTextPdf} from "./test/fixtures/pdf.ts"; writeFileSync(process.argv[1], buildTextPdf());' "$WORK_DIR/source.pdf"
UPLOAD_ID="$(curl -fsS -X POST "$BASE/api/uploads" -H 'content-type: application/pdf' -H 'x-original-filename: acceptance%20paper.pdf' --data-binary "@$WORK_DIR/source.pdf" | node --input-type=module -e 'let s=""; for await (const c of process.stdin) s+=c; process.stdout.write(JSON.parse(s).upload_id)')"
stream() {
  curl -fsS -N -X POST "$BASE/api/conversations/$CONV_ID/messages" -H 'content-type: application/json' -d "$1" > "$WORK_DIR/sse.txt"
  node --input-type=module - "$WORK_DIR/sse.txt" <<'EOF_SSE'
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
const events = readFileSync(process.argv[2], 'utf8').split('\n').filter(s => s.startsWith('data: ')).map(s => JSON.parse(s.slice(6)));
assert(events.some(e => e.type === 'done'));
assert(!events.some(e => e.type === 'error' || e.type === 'tool_result' && !e.ok), 'agent operation failed');
assert(events.some(e => e.type === 'tool_result' && e.ok));
EOF_SSE
}
stream "{\"prompt\":\"import acceptance upload\",\"upload_id\":\"$UPLOAD_ID\"}"
curl -fsS "$BASE/api/papers" > "$WORK_DIR/papers.json"
PAPER_ID="$(node -e 'process.stdout.write(require(process.argv[1])[0].paper_id)' "$WORK_DIR/papers.json")"
curl -fsS "$BASE/api/papers/$PAPER_ID" > "$WORK_DIR/paper.json"
ATTACHMENT_ID="$(node -e 'const p=require(process.argv[1]); if(p.metadata.title!=="Fixture Title" || p.attachments[0].extraction_status!=="ok" || p.attachments[0].page_count!==3) process.exit(1); process.stdout.write(p.primary_attachment_id)' "$WORK_DIR/paper.json")"
curl -fsS "$BASE/api/papers/$PAPER_ID/attachments/$ATTACHMENT_ID/file" > "$WORK_DIR/download.pdf"
cmp "$WORK_DIR/source.pdf" "$WORK_DIR/download.pdf" || fail "import changed Attachment bytes"
[[ ! -e "$DATA_DIR/uploads/$UPLOAD_ID.pdf" && ! -e "$DATA_DIR/uploads/$UPLOAD_ID.meta.json" ]] || fail "consumed upload remains"
[[ -f "$DATA_DIR/papers/$PAPER_ID/attachments/$ATTACHMENT_ID.pdf" && -f "$DATA_DIR/notes/$PAPER_ID.md" && -f "$DATA_DIR/catalog.json" ]] || fail "Library did not persist beneath the external mount"
pass "real PDF import, metadata, external persistence, consumed upload cleanup, and download"
stream "{\"prompt\":\"read $PAPER_ID\"}"
grep -q 'Page One Alpha' "$WORK_DIR/sse.txt" || fail "real PDF extraction failed"
stream "{\"prompt\":\"note $PAPER_ID\"}"
curl -fsS "$BASE/api/papers/$PAPER_ID/note?format=raw" | grep -q 'Container acceptance note.' || fail "note edit did not persist"
pass "real extraction and revision-checked note editing through provider tool calls"

curl -fsS -X PATCH "$BASE/api/conversations/$CONV_ID" -H 'content-type: application/json' -d '{"title":"Container acceptance"}' >/dev/null
compose restart paper-harness
for _ in $(seq 1 30); do
  if curl -fsS "$BASE/api/health" >/dev/null 2>&1; then break; fi
  sleep 1
done
curl -fsS "$BASE/api/conversations/$CONV_ID" > "$WORK_DIR/conversation.json"
node -e 'const c=require(process.argv[1]); if(c.meta.title!=="Container acceptance" || !c.messages.some(m=>m.role==="tool" && m.name==="import_paper")) process.exit(1)' "$WORK_DIR/conversation.json"
[[ -f "$DATA_DIR/sessions/$CONV_ID.jsonl" ]] || fail "Conversation was not persisted externally"
compose exec -T paper-harness node dist/cli/reconcile.js --json --deep > "$WORK_DIR/reconcile.json"
node -e 'const r=require(process.argv[1]); if(r.issues.length) process.exit(1)' "$WORK_DIR/reconcile.json"
pass "restart durability and deep reconciliation"
echo "Container acceptance passed"
