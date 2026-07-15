---
schema: ariadne.work-order/v1
id: ariadne-7a1e0e9c31c419e95b05b003
operation: incorporate_note
status: queued
created_at: 2026-07-14T12:01:00.000Z
approved_at: 2026-07-14T12:01:00.000Z
source_path: "Inbox/Stable.md"
source_hash: 6aae19d027a329e738090e8f2325313013f192ae9a2689f52b2d9402e9573bce
review_artifact: "System/Ariadne/Review/review-stable.md"
review_hash: dd70bdd7262fb7a16417707902670208daacc7f89ea1f5cf3335aa1daf8514ef
allowed_domains: knowledge
---
# Ariadne Approved Work Order

## Payload

```json
{"capture":{"sourcePath":"Inbox/Stable.md","content":"# Stable note\n\nThis is approved.","sourceHash":"6aae19d027a329e738090e8f2325313013f192ae9a2689f52b2d9402e9573bce","attachments":[]},"reviewMarkdown":"---\nschema: ariadne.review/v1\nid: review-fixture\noperation: incorporate_note\nstatus: proposed\nsource_path: \"Inbox/Stable.md\"\nsource_hash: 6aae19d027a329e738090e8f2325313013f192ae9a2689f52b2d9402e9573bce\n---\n# Review\n\nApproved proposal.\n"}
```
