# Paper Harness

Paper Harness is a local-first, single-user environment for managing academic
**Papers**, their **Attachments** (PDFs), and **Paper Notes**. It runs as one
small Node service on your own machine, keeps every mutable byte under a data
directory you choose, and gives you a browser UI plus a Paper Agent that can
read your library and help you work with it.

It is deliberately narrow: one writer, loopback access, and a plain-file data
model you can inspect and back up with normal tools. See
[docs/v1-limitations.md](docs/v1-limitations.md) for the full v1 scope.

## Prerequisites

- Docker Engine with the Compose plugin (`docker compose`).
- Node.js **22.19 or newer** only if you want to run the app or tests directly
  outside Docker.
- An external directory to hold your Library data.

## Environment setup

1. Copy the example environment file:

   ```sh
   cp .env.example .env
   ```

2. Edit `.env` and set at minimum:
   - `PAPER_HARNESS_HOST_DATA_DIR` — an **absolute path on the Docker host**
     where your Library will live (for example
     `/Users/you/paper-harness-data`).
   - Provider credentials. Set `LLM_PROVIDER=opencode-go` and
     `OPENCODE_GO_API_KEY=...` to use a remote model, or leave
     `LLM_PROVIDER=fake` for the deterministic offline provider.

3. Create the data directory and make sure it is writable by the container
   user. The image runs as the unprivileged `node` user (uid/gid `1000`), so on
   Linux the bind mount must be writable by that uid:

   ```sh
   mkdir -p /path/from/PAPER_HARNESS_HOST_DATA_DIR
   sudo chown 1000:1000 /path/from/PAPER_HARNESS_HOST_DATA_DIR   # Linux only
   ```

   Docker Desktop on macOS and Windows handles bind-mount permissions for you.

`.env` is untracked and must never be committed. Do not put real credentials in
`.env.example` or any tracked file.

## Docker startup

Build and start the service:

```sh
docker compose up --build
```

Then open:

**http://127.0.0.1:8787**

The port is published on loopback only. Stop the service with `Ctrl-C`, or run
it detached with `docker compose up --build -d` and stop it with
`docker compose down`.

## Cloud-provider disclosure

When you chat with the Paper Agent, **relevant Paper content and Paper Notes may
be sent to the configured LLM provider**. This is required for the agent to
answer questions about your library. The browser UI shows the same disclosure,
and `GET /api/config` returns it as `provider_disclosure`.

If you do not want any library content to leave your machine, set
`LLM_PROVIDER=fake` in `.env` before starting.

## Library data and backups

All mutable data lives under the external data root
(`PAPER_HARNESS_HOST_DATA_DIR` on the host, mounted at `/data` in the
container). The layout is:

| Path             | Contents                                            |
| ---------------- | --------------------------------------------------- |
| `catalog.json`   | Catalog of Papers, Attachments, and metadata.       |
| `papers/`        | Paper directories and their attachment PDFs.        |
| `notes/`         | Managed Paper Notes as Markdown.                    |
| `sessions/`      | Conversation history as JSONL.                      |
| `uploads/`       | Staged uploads awaiting attachment.                 |
| `tmp/`           | Scratch space used for atomic writes.               |

**Back up the entire data root directory.** The application never writes mutable
data into the source tree; the container image is disposable and can be rebuilt
at any time. To restore, point `PAPER_HARNESS_HOST_DATA_DIR` at the backed-up
directory and start again.

## Reconciliation

Reconciliation checks the catalog, notes, and attachment files for
inconsistencies and can apply known-safe repairs. Run it inside the running
container:

```sh
docker compose exec paper-harness node dist/cli/reconcile.js
```

Flags:

- `--repair` — apply only known-safe repairs (create missing Paper Notes,
  normalize managed frontmatter).
- `--deep` — recompute every Attachment SHA-256 during verification.
- `--json` — emit the full structured report as JSON.
- `--data-root <path>` — override `PAPER_HARNESS_DATA_ROOT`.

Exit status is `0` when no errors remain, `2` when errors remain, and `1` if the
run itself fails. Use the exit code to drive backups or monitoring.

## Running directly with Node (development)

Install dependencies and build:

```sh
npm ci
npm run build
```

Then either build and run the compiled output:

```sh
npm start
```

or run the TypeScript entrypoint directly with `tsx`:

```sh
npm run dev
```

Set the same environment variables described in `.env.example`. When running
outside Docker, point `PAPER_HARNESS_DATA_ROOT` at an absolute local path.

## Running tests

```sh
npm test
```

Tests use the deterministic `FakeLlmProvider` and need no network access or
credentials. The primary acceptance test (`test/acceptance.test.ts`) drives the
real HTTP/SSE server and the reconciliation command against a temporary external
data root.

### Credential-gated provider smoke test

With real OpenCode Go credentials, run the smoke test that verifies streaming
against DeepSeek V4.1 Flash and a stable Conversation session header:

```sh
OPENCODE_GO_API_KEY=... OPENCODE_GO_BASE_URL=https://opencode.ai/zen/v1 \
  npx vitest run test/provider-smoke.test.ts
```

It is skipped automatically when `OPENCODE_GO_API_KEY` is unset.

### Container acceptance

With Docker running, the container acceptance flow builds and starts Compose
against a temporary external data directory, exercises upload/SSE, asserts
loopback-only publication and data containment, and runs reconciliation inside
the container:

```sh
bash scripts/acceptance-docker.sh
```

## Known v1 limitations

v1 is intentionally minimal. See [docs/v1-limitations.md](docs/v1-limitations.md)
for the authoritative list, including no authentication, no remote access, and
no OCR or semantic search. Provider and infrastructure seams are described in
[docs/dependency-substitution.md](docs/dependency-substitution.md).

Revision-checked metadata edits use `catalog_revision` from `get_paper` as
`expected_revision`; Paper Note edits use the revision from `read_note`. Missing
or stale edit revisions are rejected. Concurrent operations within the one
supported backend process are serialized at publication, including across store
instances. Running multiple backend processes against one data root remains
unsupported.

Direct Node startup defaults to `127.0.0.1`; Compose explicitly binds all
container interfaces and publishes only on host loopback. Both Docker stages
use the exact Node `22.20.0-bookworm-slim` version tag.

`scripts/acceptance-docker.sh` runs a disposable Compose project with a temporary
external Library and an offline provider fixture. It imports a real PDF through
HTTP/SSE and semantic tools, checks extraction and metadata, edits a note,
verifies downloaded bytes and upload cleanup, restarts the application, and
runs deep reconciliation. It requires Docker Compose 2.24.4 or newer, Node,
curl, and an installed host dependency tree (`npm ci`). It never reads or
replaces the project's credential file. Set `PAPER_HARNESS_ACCEPTANCE_PORT` to
change its default loopback port, 18787.
