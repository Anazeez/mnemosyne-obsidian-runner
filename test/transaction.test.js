import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createStagedMemory, diffTrees, snapshotTree, treeDigest } from "../src/tree.js";
import { publishMemoryTransaction, recoverMemoryTransactions } from "../src/transaction.js";

const jobId = "ariadne-7a1e0e9c31c419e95b05b003";

async function root(prefix) {
  return mkdtemp(path.join(os.tmpdir(), prefix));
}

async function fixture() {
  const memoryRoot = await root("ariadne-transaction-memory-");
  const temporary = await root("ariadne-transaction-stage-");
  const transactionRoot = await root("ariadne-transaction-journal-");
  await writeFile(path.join(memoryRoot, "index.md"), "before", "utf8");
  const staged = await createStagedMemory(memoryRoot, temporary, jobId);
  await writeFile(path.join(staged.root, "index.md"), "after", "utf8");
  await mkdir(path.join(staged.root, "Knowledge"));
  await writeFile(path.join(staged.root, "Knowledge", "new.md"), "new", "utf8");
  const diff = diffTrees(staged.before, await snapshotTree(staged.root));
  return { memoryRoot, transactionRoot, staged, diff };
}

test("rolls back every injected partial-publication crash", async () => {
  for (const crashAfter of [1, 2]) {
    const state = await fixture();
    await assert.rejects(() => publishMemoryTransaction({
      transactionRoot: state.transactionRoot,
      jobId,
      memoryRoot: state.memoryRoot,
      stagedRoot: state.staged.root,
      before: state.staged.before,
      diff: state.diff,
      afterRename: async (count) => { if (count === crashAfter) throw new Error("injected crash"); }
    }), /injected crash/);

    await recoverMemoryTransactions(state.transactionRoot, state.memoryRoot, async () => false);
    assert.equal(treeDigest(await snapshotTree(state.memoryRoot)), treeDigest(state.staged.before));
    assert.deepEqual(await readdir(state.transactionRoot), []);
  }
});

test("rolls forward a fully published transaction with terminal evidence", async () => {
  const state = await fixture();
  const published = await publishMemoryTransaction({
    transactionRoot: state.transactionRoot,
    jobId,
    memoryRoot: state.memoryRoot,
    stagedRoot: state.staged.root,
    before: state.staged.before,
    diff: state.diff
  });
  assert.ok(published.transactionPath);
  await recoverMemoryTransactions(state.transactionRoot, state.memoryRoot, async () => true);
  assert.equal(await readFile(path.join(state.memoryRoot, "index.md"), "utf8"), "after");
  assert.equal(await readFile(path.join(state.memoryRoot, "Knowledge", "new.md"), "utf8"), "new");
  assert.deepEqual(await readdir(state.transactionRoot), []);
});

test("rolls back a full publication that crashed before terminal evidence", async () => {
  const state = await fixture();
  await publishMemoryTransaction({
    transactionRoot: state.transactionRoot,
    jobId,
    memoryRoot: state.memoryRoot,
    stagedRoot: state.staged.root,
    before: state.staged.before,
    diff: state.diff
  });
  await recoverMemoryTransactions(state.transactionRoot, state.memoryRoot, async () => false);
  assert.equal(treeDigest(await snapshotTree(state.memoryRoot)), treeDigest(state.staged.before));
});

test("refuses publication when live Memory changed after staging", async () => {
  const state = await fixture();
  await writeFile(path.join(state.memoryRoot, "index.md"), "concurrent edit", "utf8");
  await assert.rejects(
    () => publishMemoryTransaction({
      transactionRoot: state.transactionRoot,
      jobId,
      memoryRoot: state.memoryRoot,
      stagedRoot: state.staged.root,
      before: state.staged.before,
      diff: state.diff
    }),
    (error) => error.code === "memory_changed_during_run"
  );
});
