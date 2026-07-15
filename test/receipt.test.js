import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { formatReceipt, writeReceipt } from "../src/receipt.js";

function result(status = "succeeded") {
  return {
    job: {
      id: "ariadne-7a1e0e9c31c419e95b05b003",
      sourcePath: "Knowledge Base/Deep Work.md",
      sourceHash: "a".repeat(64),
      reviewArtifact: "System/Ariadne/Review/review.md",
      reviewHash: "b".repeat(64)
    },
    startedAt: "2026-07-14T12:00:00.000Z",
    finishedAt: "2026-07-14T12:01:00.000Z",
    status,
    lastCompletedStage: "source_postcheck",
    invocationId: "codex-run-1",
    changedFiles: ["Knowledge/deep-work.md", "index.md", "log.md", "Sources/a.md"],
    validation: { schema: "passed", boundary: "passed" },
    indexing: { results: [{ id: "section-1" }], errors: status === "partial_success" ? [{ error: "one failed" }] : [] },
    sourcePostHash: "a".repeat(64),
    retryable: status !== "succeeded",
    summary: "Completed without changing the source note. Bearer secret sk-test-token",
    diagnostics: { passkey: "super-secret" }
  };
}

test("formats complete redacted receipts for every terminal status", () => {
  for (const status of ["succeeded", "partial_success", "failed"]) {
    const markdown = formatReceipt(result(status));
    for (const required of [
      "schema: ariadne.receipt/v1", "job_id:", "source_path:", "source_hash:",
      "review_artifact:", "review_hash:", "started_at:", "finished_at:",
      `status: ${status}`, "last_completed_stage:", "changedFiles", "validation",
      "section-1", "sourcePostHash", "retryable", "summary"
    ]) assert.ok(markdown.includes(required), required);
    assert.doesNotMatch(markdown, /super-secret|secret-token|sk-test/i);
  }
});

test("persists receipts atomically and treats only identical content as idempotent", async () => {
  const reportsDir = await mkdtemp(path.join(os.tmpdir(), "ariadne-receipt-"));
  const first = await writeReceipt(reportsDir, result());
  assert.equal(first.duplicate, false);
  const second = await writeReceipt(reportsDir, result());
  assert.equal(second.duplicate, true);
  assert.equal(await readFile(first.path, "utf8"), formatReceipt(result()));
  await assert.rejects(
    () => writeReceipt(reportsDir, { ...result("failed"), summary: "different" }),
    (error) => error.code === "receipt_conflict"
  );
});
