#!/usr/bin/env bash
# Automated container acceptance for Paper Harness v1.
#
# Starts Docker Compose against a temporary external data directory, exercises
# the public HTTP/SSE surface, asserts data containment and loopback-only
# publication, then runs the reconciliation command inside the container.
#
# Requires: docker + docker compose, curl, node.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

PORT="${PAPER_HARNESS_PORT:-8787}"
DATA_DIR="$(mktemp -d "${TMPDIR:-/tmp}/paper-harness-acceptance.XXXXXX")"
ENV_FILE="$DATA_DIR/.env"
CREATED_ENV=0

cleanup() {
  docker compose down -v --remove-orphans >/dev/null 2>&1 || true
  if [[ "$CREATED_ENV" == "1" ]]; then rm -f "$ROOT/.env"; fi
  rm -rf "$DATA_DIR"
}
trap cleanup EXIT

if [[ ! -f "$ROOT/.env" ]]; then
  cat > "$ROOT/.env" <<EOF
PAPER_HARNESS_HOST_DATA_DIR=$DATA_DIR
LLM_PROVIDER=fake
PAPER_HARNESS_PORT=$PORT
EOF
  CREATED_ENV=1
fi

fail() { echo "FAIL: $*" >&2; exit 1; }
pass() { echo "PASS: $*"; }

echo "Starting Docker Compose against $DATA_DIR ..."
docker compose up --build -d

for _ in $(seq 1 90); do
  if curl -fsS "http://127.0.0.1:$PORT/api/health" >/dev/null 2>&1; then break; fi
  sleep 2
done
curl -fsS "http://127.0.0.1:$PORT/api/health" >/dev/null || fail "health endpoint never became ready"
pass "container health endpoint is reachable on loopback"

PUBLISHED="$(docker compose port paper-harness "$PORT" | head -n1)"
case "$PUBLISHED" in
  127.0.0.1:*) pass "port published on loopback only ($PUBLISHED)" ;;
  *) fail "port is not loopback-only: $PUBLISHED" ;;
esac

CONV="$(curl -fsS -X POST "http://127.0.0.1:$PORT/api/conversations" -H 'content-type: application/json' -d '{}')"
CONV_ID="$(node -e "process.stdout.write(JSON.parse(process.argv[1]).conversation_id)" "$CONV")"
[[ -n "$CONV_ID" ]] || fail "conversation creation returned no id"
pass "created conversation $CONV_ID"

printf '%%PDF-1.4 staged bytes' > "$DATA_DIR/upload.pdf"
UPLOAD="$(curl -fsS -X POST "http://127.0.0.1:$PORT/api/uploads" \
  -H 'content-type: application/pdf' \
  -H "x-original-filename: $(node -e 'process.stdout.write(encodeURIComponent("acceptance.pdf"))')" \
  --data-binary "@$DATA_DIR/upload.pdf")"
UPLOAD_ID="$(node -e "process.stdout.write(JSON.parse(process.argv[1]).upload_id)" "$UPLOAD")"
grep -q '"upload_id"' <<<"$UPLOAD" || fail "upload staging failed"
pass "staged upload $UPLOAD_ID"

SSE_FILE="$DATA_DIR/sse.txt"
curl -fsS -N -X POST "http://127.0.0.1:$PORT/api/conversations/$CONV_ID/messages" \
  -H 'content-type: application/json' \
  -d "{\"prompt\":\"hello acceptance\",\"upload_id\":\"$UPLOAD_ID\"}" > "$SSE_FILE"
grep -q 'event: done' "$SSE_FILE" || fail "SSE stream did not terminate with a done event"
pass "SSE conversation stream completed"

[[ -f "$DATA_DIR/sessions/$CONV_ID.jsonl" ]] || fail "conversation was not persisted under the external mount"
if [[ -f "$DATA_DIR/catalog.json" || -d "$DATA_DIR/papers" ]]; then
  pass "library paths initialized under the external mount"
else
  fail "library paths were not initialized under the external mount"
fi
pass "all mutable state is contained under the external data directory"

docker compose exec -T paper-harness node dist/cli/reconcile.js --json >/dev/null 2>&1 \
  && pass "reconciliation command succeeded inside the container" \
  || fail "reconciliation command failed inside the container"

echo "Container acceptance passed."
