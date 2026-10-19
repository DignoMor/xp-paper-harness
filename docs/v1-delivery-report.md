# v1 delivery gap closure report

Implementation is present in the working files, but delivery is **not fully
validated or integrated into the repository's `dev` history** because this
session's sandbox denies TCP listeners, Docker daemon access, and writes to the
repository's `.git` directory. No push or change to `main` was performed. No
files beneath the sibling sandbox Library were accessed or modified.

## Implementation commits

The working branch `fix/v1-delivery-gaps` and these commits are preserved in
temporary Git storage (`/tmp/paper-harness-v1-git`), with a portable bundle at
`/tmp/paper-harness-v1-delivery.bundle`. They are not yet in the original
repository's branch history.

| Commit | Change |
| --- | --- |
| `6309548` | Serialize Catalog/note revision checks; preserve note repair bodies; broaden orphan reports |
| `1828260` | Recover interrupted uploads and startup atomic partials |
| `a6db1cd` | Fill empty bibliographic fields from embedded PDF info/XMP |
| `3fc640b` | Require checked note writes and expose Catalog edit revisions |
| `933bcc7` | Cancel agent work on SSE disconnect; test browser fallback |
| `4e9330b` | Test failed publication, preserved data, and rollback cleanup failures |
| `f3abf3d` | Version-pin Docker/loopback defaults; exercise real imports and provider tool/header flows |
| `ae9ba8a` | Test actual SIGKILL recovery after Attachment, note, and Catalog publication |
| `091905e` | Document integrity and deployment decisions |
| `6b94771` | Reject invalid next Catalogs before serialization |

A final documentation commit records this report in the same working branch.

## Validation

| Check | Result |
| --- | --- |
| `npm run typecheck` | PASS |
| `npm run build` | PASS (server and browser assets) |
| `npm test` | Exit 1: 191 passed, 6 failed, 4 skipped; 25 files passed, 4 failed, 1 skipped |
| HTTP/provider listener failures | All six failures plus two suite setup failures report `listen EPERM` on loopback |
| Credential-gated provider smoke | Skipped: no provider credential supplied to the test environment |
| Socket-free HTTP lifecycle checks | PASS: response disconnect aborts provider; interrupted upload removes partials |
| Browser bundle fallback scenarios | PASS: restore, stale selection, disappeared Conversation, empty list, disabled storage |
| Provider wire/tool workflow | PASS: real PDF metadata/import/read, note read/edit, closed tool inventory, stable/distinct Conversation headers |
| Actual process crashes | PASS: SIGKILL after each of three publication boundaries; deterministic orphan/committed-state recovery |
| Injected store/publication failures | PASS: prior Catalog/note preserved, source upload retained, new files rolled back or reported as orphans |
| Docker acceptance execution | Blocked: Docker daemon socket connection denied by sandbox |
| Docker acceptance script and provider fixture syntax | PASS |
| Git whitespace check | PASS |

Full suite output: `/tmp/paper-harness-v1-tests.log`. Docker attempt output:
`/tmp/paper-harness-v1-docker.log`.

The expanded Docker acceptance uses the canonical Compose service with isolated
environment overrides, a unique project, disposable Library data, a genuine
three-page PDF, and an offline OpenAI-wire provider fixture. It checks semantic
import, extracted metadata/text, unchanged downloaded bytes, consumed upload
cleanup, note editing, restart persistence, deep reconciliation, and loopback
publication. Its provider fixture also passes the deterministic offline tool
workflow. Running the actual containers still needs an unrestricted environment.

## Decisions and remaining work

The accepted dependency substitution is unchanged; no DSH plugins were added.
See [integrity decisions](v1-integrity.md) for revision, repair, extraction,
cleanup, and cancellation details. Catalog/note concurrency is supported within
the single backend process, including multiple store instances. Multiple
backend writers remain outside v1 scope. Imports/additions revalidate uniqueness
inside their Catalog transaction; metadata and primary edits require a revision.
Docker uses the exact `22.20.0-bookworm-slim` version tag in both stages. The
browser tests execute the real bundle with a minimal DOM rather than a graphical
browser engine.

`$implement` and `/tdd` skill packages were not available in this session. The
work followed a direct test-first workflow: reproduce integrity/metadata/default
failures, implement fixes, and verify the new behavior. Cancellation was also
checked against the old handler to establish that its regression test fails.

Outstanding delivery gates: rerun the complete suite with loopback listeners
permitted; run Docker acceptance with daemon access; run the live provider smoke
with credentials; then merge the working branch into the original `dev` and
verify an empty `git status`. The original repository currently remains on
`dev` with these implementation changes visible as working-tree changes. Its
`.git` directory is read-only to this session, so branch creation, commits, and
merge could only be prepared in temporary Git storage. The passing-all-checks
and clean-integrated-`dev` requirements have therefore not been met.
