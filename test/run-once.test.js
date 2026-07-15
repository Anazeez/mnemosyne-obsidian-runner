import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
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
    createStagedMemory: async () => ({ root: "/tmp/staged-memory", before: new Map(), digest: "memory-before" }),
    publishMemoryDiff: async () => ({ changedFiles: [] }),
    renewClaim: async (_paths, claim) => claim,
    withClaimOwnership: async (_paths, _claim, callback) => callback(),
    removeStaging: async () => {},
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
    readReceipt: async () => null,
    now: (() => { let tick = 0; return () => new Date(1_752_494_400_000 + tick++ * 1000); })(),
    ...overrides
  };
  return { deps, stages, receipts, completions, sourceReads: () => sourceReads };
}

function config(vaultRoot) {
  return {
    vaultRoot, runnerId: "test", leaseMs: 120_000,
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
  assert.equal(state.receipts[0].retryable, false);
  assert.deepEqual(state.receipts[0].retryableStages, ["indexing"]);
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

test("resumes completion from an existing terminal receipt without rerunning Codex", async () => {
  const { vaultRoot, job } = await setup();
  let codexRuns = 0;
  const state = dependencies(job, {
    readReceipt: async () => ({
      path: "/tmp/existing-receipt",
      result: { job, status: "succeeded", stageTimestamps: {}, indexing: { results: [], errors: [] } }
    }),
    runCodex: async () => { codexRuns += 1; }
  });
  const result = await runOne(config(vaultRoot), state.deps);
  assert.equal(result.exitCode, 0);
  assert.equal(result.status, "succeeded");
  assert.equal(codexRuns, 0);
  assert.equal(state.completions.length, 1);
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

test("rejects symlinked Queue, Claims, Reports, and Memory roots", async () => {
  for (const relative of [
    "System/Ariadne/Runtime/Queue",
    "System/Ariadne/Runtime/Claims",
    "System/Ariadne/Runtime/Transactions",
    "System/Ariadne/Reports",
    "System/Ariadne/Memory"
  ]) {
    const vaultRoot = await mkdtemp(path.join(os.tmpdir(), "ariadne-symlink-vault-"));
    const outside = await mkdtemp(path.join(os.tmpdir(), "ariadne-symlink-outside-"));
    const target = path.join(vaultRoot, ...relative.split("/"));
    await mkdir(path.dirname(target), { recursive: true });
    await symlink(outside, target);
    const result = await runOne(config(vaultRoot), {});
    assert.equal(result.exitCode, 4, relative);
    assert.match(result.message, /unsafe|symlink/i, relative);
  }
});

test("invalid staged output is never published to live Memory", async () => {
  const { vaultRoot, job } = await setup();
  let published = 0;
  const state = dependencies(job, {
    validateMemoryDiff: async () => {
      throw new RunnerError("output_validation", "invalid_memory_schema", "invalid");
    },
    publishMemoryDiff: async () => { published += 1; }
  });
  const result = await runOne(config(vaultRoot), state.deps);
  assert.equal(result.exitCode, 3);
  assert.equal(published, 0);
});

test("writes a durable diagnostic instead of silently skipping an invalid queue file", async () => {
  const vaultRoot = await mkdtemp(path.join(os.tmpdir(), "ariadne-invalid-queue-"));
  const queueDir = path.join(vaultRoot, "System/Ariadne/Runtime/Queue");
  await mkdir(queueDir, { recursive: true });
  await writeFile(path.join(queueDir, "broken.md"), "not a work order");
  const result = await runOne(config(vaultRoot), {});
  assert.equal(result.exitCode, 3);
  assert.equal(result.status, "failed");
  assert.match(result.reportPath, /invalid-work-order-/);
  assert.match(await readFile(result.reportPath, "utf8"), /invalid_work_order/);
});

test("expired recovery refuses a Memory snapshot mismatch before Codex", async () => {
  const { vaultRoot, job } = await setup();
  let codexRuns = 0;
  const state = dependencies(job, {
    claimJob: async () => ({
      status: "claimed",
      claim: { jobId: job.id, claimId: "replacement", runnerId: "test", claimPath: "/tmp/claim" },
      recoveredFrom: { memorySnapshotHash: "old-snapshot" }
    }),
    createStagedMemory: async () => ({ root: "/tmp/staged", before: new Map(), digest: "new-snapshot" }),
    runCodex: async () => { codexRuns += 1; }
  });
  const result = await runOne(config(vaultRoot), state.deps);
  assert.equal(result.exitCode, 3);
  assert.equal(result.error.code, "recovery_snapshot_mismatch");
  assert.equal(codexRuns, 0);
});

test("serializes all Memory writers before transaction recovery and queue selection", async () => {
  const vaultRoot = await mkdtemp(path.join(os.tmpdir(), "ariadne-writer-lock-"));
  let enteredResolve;
  let releaseResolve;
  const entered = new Promise((resolve) => { enteredResolve = resolve; });
  const release = new Promise((resolve) => { releaseResolve = resolve; });
  const first = runOne(config(vaultRoot), {
    recoverMemoryTransactions: async () => {
      enteredResolve();
      await release;
    }
  });
  await entered;
  const second = await runOne(config(vaultRoot), {});
  assert.equal(second.exitCode, 2);
  assert.equal(second.status, "runner_busy");
  releaseResolve();
  assert.equal((await first).status, "no_job");
});
