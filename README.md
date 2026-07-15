# Mnemosyne Ariadne action runner

This service consumes explicitly approved Ariadne work orders from an Obsidian
vault mirror, runs Codex inside the isolated `System/Ariadne/Memory` directory,
validates the resulting compiled wiki, indexes the knowledge page in Mnemosyne,
and writes a terminal receipt back into the synchronized vault.

It never edits the approved source note. Creating, clipping, pasting, or syncing
a note does not create a work order; approval in the Obsidian plugin is required.

## Prerequisites

- Node.js 20.12 or newer.
- Codex CLI installed and already authenticated for the runner account.
- Obsidian Headless Sync configured with a dedicated local mirror of the same
  Standard Sync remote used by the mobile vault.
- A Worker URL and runner-held Ariadne passkey. Secrets must remain outside the
  vault and must not be placed in work orders, receipts, or `Memory/`.

Copy `.env.example` to `.env` and use the local Headless Sync mirror as
`VAULT_ROOT`. Do not commit `.env`.

## Ownership and synchronization

Obsidian owns source notes, reviews, approvals, and work-order creation. The
runner owns claim/completion files, compiled Memory artifacts, and reports.
Headless Sync transports those files; it is not an authorization mechanism.

Before running a job, verify the mirror is current:

```sh
ob sync-status
```

Use the exact vault selector required by the installed Headless Sync version.
After the runner finishes, allow Headless Sync to upload the Memory artifacts and
receipt. The terminal report appears at:

```text
System/Ariadne/Reports/receipt-<job-id>.md
```

## Run one job

```sh
npm test
npm run run:once
```

The runner processes queue filenames in lexical order and stops after one
terminal job:

- `0`: succeeded, partial success, or an already-completed duplicate.
- `2`: no claimable queued job was available.
- `3`: the job failed and a durable failure receipt was written.
- `4`: configuration, receipt persistence, or completion persistence failed.

An expired claim may be reclaimed by a later invocation. Inspect the matching
claim, completion, and receipt before manual recovery; never delete a claim while
another runner could still be active.

Do not run the legacy `ariadne-intake-review.js` process concurrently. It uses a
different intake loop and is not part of the approval-bound action workflow.

## Safety boundary

Codex is launched without a shell using `--sandbox workspace-write`, with
`Memory/` as its working directory, an ephemeral session, and a strict structured
output schema. No additional writable directory is supplied. The runner rejects
symlinks, deletions, paths outside Memory, unexpected files, malformed
frontmatter, hash mismatches, and duplicate index or log entries before indexing.
