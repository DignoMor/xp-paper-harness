# Paper Harness v1 limitations

Paper Harness v1 is a deliberately small, local-first release. The following
are out of scope for v1.

- **No authentication and no remote access.** The service is unauthenticated and
  binds to loopback only. Do not expose it on a public interface or share the
  port. There are no accounts, sessions for users, or access control.
- **No direct human editing in the browser.** Paper Notes and metadata are
  managed by the application and the Paper Agent; the UI does not offer free-form
  editing of notes or catalog fields.
- **No conversation delete or archive.** Conversations can be created, listed,
  opened, and renamed, but not deleted or archived from the UI.
- **No OCR and no scanned-PDF reading.** Only text embedded in PDFs is
  extracted. Image-only or scanned documents yield no text.
- **No embeddings or semantic search.** There is no vector store and no
  similarity search; lookups are catalog- and text-based.
- **No duplicate merging.** Re-ingesting an exact-hash Attachment is rejected,
  and a matching DOI produces a warning only. Duplicates are never merged
  automatically.
- **No Zotero sync or API compatibility.** There is no Zotero import, export, or
  API compatibility.
- **No persisted extracted-text cache.** Extracted PDF text is produced on
  demand and is not cached durably between requests.
- **No MCP exposure.** No Model Context Protocol server or tools are exposed.
- **No Paper or Attachment deletion.** Papers and attachments cannot be deleted
  through the application.
- **Single writer.** Only one process may write to a data root at a time. Run a
  single instance against a given data directory; there is no locking or
  coordination for concurrent writers.
