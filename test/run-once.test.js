import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { RunnerError, parseWorkOrder } from "../src/contracts.js";
import { runOne } from "../src/run-once.js";

const fixture = new URL("./fixtures/work-order-v1.md", import.meta.url);

async function setup() {
  const vaultRoot = await mkdtemp(path.join(os.tmpdir(), "ariadne-run-"));
  const queueDir = path.join(vaultRoot, "System/Ariadne/Runtime/Queue");
  await mkdir(queueDir, { recursive: true });
  const markdown = await readFile(fixture, "utf8");
  const job = parseWorkOrder(markdown);
  await writeFile(path.join(queueDir, `${job.id}.md`), markdown);
  return { vaultRoot, job };
}

function dependencies(job, overrides = {}) {
  const stages = [];
  const receipts = [];
  const completions = [];
  let sourceReads = 0;
  const deps = {
    onStage: (stage) => stages.push(stage),
    claimJob: async (_paths, claimedJob) => ({
      status: "claimed",
      claim: { jobId: claimedJob.id, runnerId: "test", claimPath: "/tmp/claim" }
    }),
    completeClaim: async (_paths, _claim, completion) => { completions.push(completion); },
    readSource: async () => { sourceReads += 1; return job.capture.content; },
    installMemoryRules: async () => false,
    snapshotTree: async () => new Map(),
    runCodex: async () => ({ status: "completed", job_id: job.id, changed_files: [], summary: "done" }),
    diffTrees: () => ({ created: ["four files"], modified: [], deleted: [] }),
    validateMemoryDiff: async () => ({
      knowledgePath: "Knowledge/deep-work.md",
      sourceManifestPath: `Sources/${job.sourceHash}.md`,
      changedFiles: ["Knowledge/deep-work.md", "Sources/source.md", "index.md", "log.md"],
      bodyHash: job.sourceHash
    }),
    readMemoryFile: async () => `---\nsha256: ${job.sourceHash}\n---\n${job.capture.content}`,
    indexKnowledgePage: async () => ({ status: "succeeded", documentHash: job.sourceHash, results: [{ id: "section-1" }], errors: [] }),
    writeReceipt: async (_dir, receipt) => { receipts.push(receipt); return { path: "/tmp/receipt", duplicate: false }; },
    now: (() => { let tick = 0; return () => new Date(1_752_494_400_000 + tick++ * 1000); })(),
    ...overrides
  };
  return { deps, stages, receipts, completions, sourceReads: () => sourceReads };
}

function config(vaultRoot) {
  return {
    vaultRoot, runnerId: "test", leaseMs: 60_000,
    codexBin: "codex", codexTimeoutMs: 1000,
    workerBase: "https://worker", passkey: "secret", indexTimeoutMs: 1000
  };
}

test("runs one job in the exact durable stage order", async () => {
  const { vaultRoot, job } = await setup();
  const state = dependencies(job);
  const result = await runOne(config(vaultRoot), state.deps);
  assert.equal(result.exitCode, 0);
  assert.equal(result.status, "succeeded");
  assert.deepEqual(state.stages, [
    "claim", "source_precheck", "snapshot", "codex", "diff_validation",
    "memory_written", "indexing", "source_postcheck", "receipt", "completion"
  ]);
  assert.equal(state.receipts.length, 1);
  assert.equal(state.completions.length, 1);
  assert.equal(state.sourceReads(), 2);
});

test("preserves partial indexing as a terminal partial success", async () => {
  const { vaultRoot, job } = await setup();
  const state = dependencies(job, {
    indexKnowledgePage: async () => ({ status: "partial_success", documentHash: job.sourceHash, results: [], errors: [{ error: "section failed" }] })
  });
  const result = await runOne(config(vaultRoot), state.deps);
  assert.equal(result.exitCode, 0);
  assert.equal(result.status, "partial_success");
  assert.equal(state.receipts[0].status, "partial_success");
});

test("writes failed receipts for Codex, diff, and changed-source failures", async () => {
  for (const [name, overrides, code] of [
    ["codex", { runCodex: async () => { throw new RunnerError("codex_execution", "codex_execution_failed", "failed", true); } }, "codex_execution_failed"],
    ["diff", { validateMemoryDiff: async () => { throw new RunnerError("output_validation", "invalid_memory_schema", "bad diff"); } }, "invalid_memory_schema"],
    ["source", { readSource: (() => { let n = 0; return async () => ++n === 1 ? null : "changed"; })() }, "source_hash_changed"]
  ]) {
    const { vaultRoot, job } = await setup();
    if (name === "source") overrides.readSource = (() => { let n = 0; return async () => ++n === 1 ? job.capture.content : "changed"; })();
    const state = dependencies(job, overrides);
    const result = await runOne(config(vaultRoot), state.deps);
    assert.equal(result.exitCode, 3, name);
    assert.equal(state.receipts[0].status, "failed", name);
    assert.equal(state.receipts[0].error.code, code, name);
  }
});

test("receipt persistence failure is fatal and does not mark completion", async () => {
  const { vaultRoot, job } = await setup();
  const state = dependencies(job, { writeReceipt: async () => { throw new Error("disk unavailable"); } });
  const result = await runOne(config(vaultRoot), state.deps);
  assert.equal(result.exitCode, 4);
  assert.equal(state.completions.length, 0);
});

test("returns no-job and already-completed outcomes without execution", async () => {
  const emptyRoot = await mkdtemp(path.join(os.tmpdir(), "ariadne-empty-"));
  assert.equal((await runOne(config(emptyRoot), {})).exitCode, 2);

  const { vaultRoot, job } = await setup();
  const state = dependencies(job, { claimJob: async () => ({ status: "completed", completion: { status: "succeeded" } }) });
  const result = await runOne(config(vaultRoot), state.deps);
  assert.equal(result.status, "already_completed");
  assert.equal(result.exitCode, 0);
  assert.deepEqual(state.stages, ["claim"]);
});
