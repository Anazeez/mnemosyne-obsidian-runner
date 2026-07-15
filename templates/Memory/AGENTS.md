# Ariadne Memory Rules

This directory is a compiled wiki, not a copy of the source vault.

- Assert only facts present in the explicitly approved source snapshot. Mark uncertainty explicitly.
- Write only the deterministic target paths supplied in the job prompt.
- `Knowledge/` pages synthesize useful, interlinked knowledge and retain source provenance and hashes.
- `Sources/` manifests identify the immutable approved source path and SHA-256.
- `index.md` is content-oriented and contains each knowledge-page link once.
- `log.md` is append-only, keyed by Ariadne job ID, and contains each job once.
- Deletions are forbidden in v1.
- Do not access source notes, secrets, sibling vault paths, or files outside this Memory directory.
- Do not use the network or run commands that make network requests.
- Every knowledge page must use `schema: ariadne.memory/v1`, `status: canon`, all required ingest frontmatter, and a `sha256` matching the canonical body.
