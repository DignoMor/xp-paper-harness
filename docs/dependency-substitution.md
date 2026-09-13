# Dependency substitution

## Why this document exists

The original Paper Harness specification named a few concrete services and
packages that are not published on npm in this environment:

- the **DeepSeek Harness (DSH)** leaf services,
- a standalone **`dsh-pdf`** package, and
- a community **OpenCode Go provider plugin**.

Rather than depend on unpublished or environment-specific packages, v1 defines
provider-neutral ports and ships small, pinned adapters behind them. The
domain and application layers depend only on the ports, so the named services
can be swapped in later without touching business logic. This is a
**compatibility seam, not a new PDF parser**.

## LLM provider seam

The application consumes an `LlmProvider` interface declared in
`src/application/ports.ts`. It is intentionally transport-agnostic: callers
stream `LlmEvent`s from a chat request and never see HTTP, SSE, or vendor
details.

Two adapters implement the port:

- **`FakeLlmProvider`** (`src/llm/fake-provider.ts`) — deterministic, offline,
  and scriptable. It is used by the tests and is selected with
  `LLM_PROVIDER=fake`, so the test suite needs no network or credentials.
- **`OpenCodeGoProvider`** (`src/llm/opencode-go-provider.ts`) — an
  OpenAI-compatible streaming adapter. It is configured entirely through
  environment variables:

  | Variable                      | Purpose                                  |
  | ----------------------------- | ---------------------------------------- |
  | `OPENCODE_GO_API_KEY`         | Bearer token for the service.            |
  | `OPENCODE_GO_BASE_URL`        | Base URL of the OpenAI-compatible API.   |
  | `OPENCODE_GO_MODEL`           | Model identifier.                        |
  | `OPENCODE_GO_SESSION_HEADER`  | Header used to propagate the session id. |

`createLlmProviderFromEnv` (`src/llm/index.ts`) chooses the adapter at startup.
Any future DSH or OpenCode Go plugin can replace `OpenCodeGoProvider` as long as
it implements `LlmProvider`.

## PDF reading seam

PDF extraction is hidden behind the `PdfReaderPort` interface in
`src/application/ports.ts`. The v1 adapter is backed by **`pdfjs-dist`**
(`src/infrastructure/pdf/pdfjs-reader.ts`), pinned in `package.json`.

`dsh-pdf`, the package named by the original spec, is not available here, so
`pdfjs-dist` stands in as the documented, pinned extraction seam that provides
equivalent behavior: page extraction, page/byte/character truncation, and a
structured `PdfExtraction` result including an `image_only` status for documents
without a text layer. Because callers only see `PdfReaderPort`, replacing
`pdfjs-dist` with a real `dsh-pdf` adapter later is a localized change.

## Conversation store seam

The DSH Session service is replaced by a small durable **JSONL Conversation
store** (`src/conversations/conversation-store.ts`). Each conversation is a
`.jsonl` file under the data root's `sessions/` directory, with a metadata line
followed by message lines. Appends are serialized through an in-process queue
and writes are atomic, which is sufficient for the single-writer model of v1.
The store's public surface is independent of any DSH Session API, so a future
Session service can be substituted behind the same behavior.

## What stays stable

The domain and application layers (`src/domain/`, `src/application/`) import
only the ports, never the adapters. Composition happens in a single place,
`src/composition.ts`. This keeps Paper Harness transport- and
provider-independent and lets the real DSH leaf services, `dsh-pdf`, and the
OpenCode Go provider plugin be dropped in behind the existing seams when they
become available.
