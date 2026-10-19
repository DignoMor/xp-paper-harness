# 1.0.0 release review

Reviewed the complete tracked `dev` tree against the v1 delivery requirements,
API contracts, architecture decisions, and workspace standards. No local `main`
ref exists, so this was a whole-tree first-release review. The API contracts
explicitly authorize the LLM, PDF, and Conversation dependency substitutions.

## Standards

Fixed the two disclosure findings: routine startup logging included the host
data directory, and unexpected HTTP/tool exceptions included raw messages that
could expose paths or credentials. Removed raw diagnostic text from those
boundaries, malformed Catalog/note parsing, and unexpected startup/CLI failures;
PDF adapter failures and deep-reconciliation read failures now use safe text.
Regression tests cover HTTP and tool errors and corrupt Catalog errors.

Confirmed direct startup defaults to loopback and Compose publishes only
`127.0.0.1:8787`. `.env` is ignored and untracked, with no `.env` or `.env.local`
entries in `HEAD` history. A history scan found no local credential matches or
high-confidence private-key/token patterns; this is a scoped scan, not a proof
that every possible secret format is absent.

## Spec

Fixed release-blocking correctness/security findings, with regression coverage:

- Conversation IDs were used in paths without validation. Reject malformed IDs
  before filesystem access and ignore invalid filenames in Conversation lists.
- Appending or renaming after an interrupted JSONL tail corrupted subsequent
  history. Recover the partial tail atomically before appending and share the
  write queue across store instances.
- Concurrent agent runs could interleave one Conversation's turns. Reject an
  overlapping response and release the guard on completion or cancellation.
  Tool-loop exhaustion now emits only its terminal error.
- Provider tool fragments were drained when their index changed, breaking
  interleaved calls. Accumulate by index; sanitize stream failures and reject
  premature termination instead of dispatching pending tool calls. Failed
  provider turns do not persist unexecuted tool calls.
- Markdown links could bypass the JavaScript scheme check with ASCII control
  characters. Use an HTML namespace/tag/attribute allowlist and parsed URL
  protocol checks; exclude SVG and other active content. Tests inspect the
  sanitizer with browser-decoded DOM attribute fixtures, not a full browser.

Also fixed a lower-priority integrity gap: reject malformed SHA-256 digests and
unsafe integer values. Tests verify malformed Catalog evidence remains intact
and reconciliation reports corruption.

Nonblocking architecture deviation: the web adapter uses `node:http` directly
rather than the specified Cordis web plugin. The HTTP contract is implemented;
this structural difference remains for a later architecture decision. Existing
`v1-delivery-report.md` describes the earlier implementation session and is a
historical report, not this release's current validation status.

## Release and validation

Set both package manifests to `1.0.0` and added the first-release changelog.
Typecheck and the server/browser build pass. The full suite reports 210 passed,
6 failed, and 4 skipped; all six failures and two suite setup failures are
loopback `listen EPERM` restrictions. The skipped cases include the
credential-gated live provider smoke and tests blocked by suite setup. No other
test failures were ignored. Docker acceptance and live-provider validation were
not run for this release review. Whitespace validation passes.

All changes remain uncommitted on `dev`. No commit, push, tag, branch switch,
merge, or `.git` write was performed.

## Suggested commits by logical change

1. `fix(conversations): validate identities and recover interrupted logs`
2. `fix(agent): prevent overlapping Conversation responses and terminal events`
3. `fix(llm): preserve interleaved tool calls and reject broken streams`
4. `fix(security): redact internal paths and exception details`
5. `fix(web): harden Markdown rendering against active content`
6. `fix(catalog): reject malformed hashes and unsafe integers`
7. `chore(release): prepare Paper Harness 1.0.0`
