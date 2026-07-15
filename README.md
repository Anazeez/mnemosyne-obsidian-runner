# Mnemosyne Obsidian Runner

Review-first Ariadne intake runner with deterministic contextual continuity.

For every Markdown note in `Inbox/`, the runner performs this real request
sequence:

1. `POST /v1/continuity/rehydrate` using an explicit identity, project, and
   scope.
2. Build an invocation package in which the exact Runway is primary and vector
   results remain `supplemental_evidence`.
3. Call `/api/ariadne/core/intake` with the retrieval receipt in
   `X-Continuity-Receipt`.
4. Write a separate review proposal without changing the source note.
5. Complete the continuity invocation as unchanged, or record checkpoint
   failure if the intake fails.

No Worker endpoint is embedded. Copy `.env.example` to a private runtime
environment and provide every required value. Never commit that private file.

```bash
npm ci
npm test
node ariadne-intake-review.js
```

The reusable client supports changed checkpoint completion only when
`submitCheckpoint: true` is supplied explicitly. The executable runner does not
silently submit a checkpoint, publish a Runway, activate a binding, or deploy
anything. `CONTINUITY_SUBMIT_CHECKPOINT=false` documents that default for
operators; changing it alone does not bypass the explicit client confirmation.

Network and upstream errors are reduced to bounded codes. Raw response bodies,
credentials, provider payloads, and internal endpoints are not written to
review artifacts or logs.
