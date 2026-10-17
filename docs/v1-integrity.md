# v1 integrity decisions

The accepted dependency substitution remains in effect. This change does not
add DSH plugins, a new PDF parser, or another persistence backend.

Catalog transactions and direct saves share a process-wide queue per resolved
file path. Each save reloads the current Catalog and accepts only the next
revision. Paper/Attachment metadata edits and primary changes require an
explicit `expected_revision`, available as `catalog_revision` from `get_paper`.
Imports and supplementary additions may omit a revision: they add distinct IDs
against the current Catalog inside the transaction, rechecking hash uniqueness
and DOI collisions there. They cannot overwrite an existing metadata edit.
Multiple processes writing the same Library remain unsupported.

All Paper Note writes compare the complete previously read raw file (or null
when creating a missing note) and publish atomically under a shared per-file
queue. This also protects note bodies when frontmatter synchronization or
reconciliation races with an edit. A concurrent change rejects the write; the
caller must reread. Body revisions remain unchanged in format. Serialization
preserves leading body newlines.

Repair extracts the body of a delimited frontmatter block even when its YAML is
invalid. When no complete block exists, repair preserves the entire original
file as the body. Published ambiguous artifacts remain report-only. Reconciliation
checks stored Attachment paths against ID-derived locations and recursively
scans Paper and note areas, including arbitrary names and uppercase extensions.
It also reports orphans when the Catalog has not yet been created.

Startup removes reserved atomic staging files (`.tmp-` followed by sixteen hex
characters) without following symlinks. Upload expiry handles complete pairs,
invalid metadata, metadata-less PDFs, and streaming partials, using filesystem
age for incomplete artifacts. Failed upload publication rolls back its PDF;
failed import publication retains its staged source and rolls back new Library
artifacts where possible. Rollback failures remain visible as orphans.

Embedded PDF info and XMP can fill title, creators, abstract, publication,
volume, issue, pages, publication date, DOI, URL, and tags. Supplied non-empty
values win. Empty strings, whitespace, and empty arrays permit extraction;
missing titles still fall back to the original filename. Authors remain single
name values rather than guessing personal-name boundaries. Technical PDF
creation timestamps are not presented as publication dates. No online lookup
is introduced.

SSE response closure aborts provider work. A completed HTTP request body does
not cancel its response. The agent checks cancellation before accepting model
events or dispatching tools, including when a provider ignores its signal.
Already-running atomic Library operations finish safely.

The runtime image uses an exact Node version tag in both stages; the tag does
not provide a digest-level immutability guarantee. Direct Node startup defaults
to loopback, while Compose explicitly sets its container bind address.
