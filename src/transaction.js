import { randomUUID } from "node:crypto";
import {
  copyFile,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
  unlink
} from "node:fs/promises";
import path from "node:path";

import { RunnerError } from "./contracts.js";
import { snapshotTree, treeDigest } from "./tree.js";

function transactionError(code, message, retryable = false) {
  return new RunnerError("memory_transaction", code, message, retryable);
}

function safeRelative(value) {
  if (typeof value !== "string" || path.posix.isAbsolute(value) || value.includes("\\")) {
    throw transactionError("memory_transaction_invalid", "Transaction path is invalid.");
  }
  const normalized = path.posix.normalize(value);
  if (!normalized || normalized === "." || normalized === ".." || normalized.startsWith("../") || normalized !== value) {
    throw transactionError("memory_transaction_invalid", "Transaction path escapes Memory.");
  }
  return normalized;
}

async function syncFile(filePath) {
  const handle = await open(filePath, "r");
  try { await handle.sync(); } finally { await handle.close(); }
}

async function syncDirectory(directory) {
  const handle = await open(directory, "r");
  try { await handle.sync(); } finally { await handle.close(); }
}

async function durableJson(filePath, value) {
  const temporary = `${filePath}.tmp-${randomUUID()}`;
  const handle = await open(temporary, "wx");
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temporary, filePath);
  await syncDirectory(path.dirname(filePath));
}

async function publishFile(source, destination) {
  await mkdir(path.dirname(destination), { recursive: true });
  const temporary = `${destination}.publish-${randomUUID()}`;
  await copyFile(source, temporary);
  await syncFile(temporary);
  await rename(temporary, destination);
  await syncDirectory(path.dirname(destination));
}

function validateJournal(journal) {
  if (!journal || journal.schema !== "ariadne.memory-transaction/v1" ||
      !/^ariadne-[0-9a-f]{24}$/.test(journal.jobId) ||
      !Array.isArray(journal.created) || !Array.isArray(journal.modified) ||
      !/^[0-9a-f]{64}$/.test(journal.beforeDigest) || !/^[0-9a-f]{64}$/.test(journal.afterDigest)) {
    throw transactionError("memory_transaction_invalid", "Memory transaction journal is invalid.");
  }
  journal.created = journal.created.map(safeRelative);
  journal.modified = journal.modified.map(safeRelative);
  return journal;
}

async function readJournal(transactionPath) {
  try {
    return validateJournal(JSON.parse(await readFile(path.join(transactionPath, "journal.json"), "utf8")));
  } catch (error) {
    if (error instanceof RunnerError) throw error;
    throw transactionError("memory_transaction_invalid", "Memory transaction journal cannot be read.");
  }
}

export async function publishMemoryTransaction(options) {
  const { transactionRoot, jobId, memoryRoot, stagedRoot, before, diff } = options;
  if (treeDigest(await snapshotTree(memoryRoot)) !== treeDigest(before)) {
    throw transactionError("memory_changed_during_run", "Live Memory changed while Codex was running.");
  }
  await mkdir(transactionRoot, { recursive: true });
  const transactionPath = path.join(transactionRoot, jobId);
  const preparingPath = path.join(transactionRoot, `.prepare-${jobId}-${randomUUID()}`);
  await mkdir(preparingPath);
  let workingPath = preparingPath;
  let beforeRoot = path.join(workingPath, "before");
  let afterRoot = path.join(workingPath, "after");
  await Promise.all([mkdir(beforeRoot), mkdir(afterRoot)]);
  const created = [...diff.created].sort().map(safeRelative);
  const modified = [...diff.modified].sort().map(safeRelative);
  const changed = [...created, ...modified].sort();

  for (const relativePath of changed) {
    const stagedFile = path.join(stagedRoot, ...relativePath.split("/"));
    const afterFile = path.join(afterRoot, ...relativePath.split("/"));
    await mkdir(path.dirname(afterFile), { recursive: true });
    await copyFile(stagedFile, afterFile);
    await syncFile(afterFile);
    await syncDirectory(path.dirname(afterFile));
  }
  for (const relativePath of modified) {
    const liveFile = path.join(memoryRoot, ...relativePath.split("/"));
    const backupFile = path.join(beforeRoot, ...relativePath.split("/"));
    await mkdir(path.dirname(backupFile), { recursive: true });
    await copyFile(liveFile, backupFile);
    await syncFile(backupFile);
    await syncDirectory(path.dirname(backupFile));
  }

  const after = await snapshotTree(stagedRoot);
  const journal = {
    schema: "ariadne.memory-transaction/v1",
    jobId,
    status: "prepared",
    beforeDigest: treeDigest(before),
    afterDigest: treeDigest(after),
    created,
    modified
  };
  await durableJson(path.join(workingPath, "journal.json"), journal);
  await syncDirectory(workingPath);
  await rename(workingPath, transactionPath);
  workingPath = transactionPath;
  beforeRoot = path.join(workingPath, "before");
  afterRoot = path.join(workingPath, "after");
  await syncDirectory(transactionRoot);

  let published = 0;
  for (const relativePath of changed) {
    await publishFile(
      path.join(afterRoot, ...relativePath.split("/")),
      path.join(memoryRoot, ...relativePath.split("/"))
    );
    published += 1;
    await options.afterRename?.(published, relativePath);
  }
  if (treeDigest(await snapshotTree(memoryRoot)) !== journal.afterDigest) {
    throw transactionError("memory_write_failed", "Published Memory does not match the staged transaction.");
  }
  await durableJson(path.join(transactionPath, "journal.json"), { ...journal, status: "published" });
  return { transactionPath, afterDigest: journal.afterDigest, changedFiles: changed };
}

async function rollback(transactionPath, memoryRoot, journal) {
  for (const relativePath of journal.modified) {
    await publishFile(
      path.join(transactionPath, "before", ...relativePath.split("/")),
      path.join(memoryRoot, ...relativePath.split("/"))
    );
  }
  for (const relativePath of journal.created) {
    try { await unlink(path.join(memoryRoot, ...relativePath.split("/"))); }
    catch (error) { if (error?.code !== "ENOENT") throw error; }
  }
  if (treeDigest(await snapshotTree(memoryRoot)) !== journal.beforeDigest) {
    throw transactionError("memory_recovery_failed", "Memory rollback did not restore the pre-run snapshot.");
  }
}

async function rollForward(transactionPath, memoryRoot, journal) {
  for (const relativePath of [...journal.created, ...journal.modified].sort()) {
    await publishFile(
      path.join(transactionPath, "after", ...relativePath.split("/")),
      path.join(memoryRoot, ...relativePath.split("/"))
    );
  }
  if (treeDigest(await snapshotTree(memoryRoot)) !== journal.afterDigest) {
    throw transactionError("memory_recovery_failed", "Memory roll-forward did not restore the validated snapshot.");
  }
}

export async function recoverMemoryTransactions(transactionRoot, memoryRoot, isTerminal) {
  await mkdir(transactionRoot, { recursive: true });
  const entries = (await readdir(transactionRoot, { withFileTypes: true }))
    .sort((left, right) => left.name.localeCompare(right.name));
  const recovered = [];
  for (const entry of entries) {
    if (entry.name.startsWith(".prepare-")) {
      if (!entry.isDirectory()) throw transactionError("memory_transaction_invalid", "Invalid prepared transaction entry.");
      await rm(path.join(transactionRoot, entry.name), { recursive: true, force: true });
      continue;
    }
    if (!entry.isDirectory() || !/^ariadne-[0-9a-f]{24}$/.test(entry.name)) {
      throw transactionError("memory_transaction_invalid", "Unexpected Memory transaction directory.");
    }
    const transactionPath = path.join(transactionRoot, entry.name);
    const stat = await lstat(transactionPath);
    if (stat.isSymbolicLink()) throw transactionError("memory_transaction_invalid", "Symlinked Memory transaction rejected.");
    const journal = await readJournal(transactionPath);
    const terminal = await isTerminal(journal.jobId);
    if (terminal) await rollForward(transactionPath, memoryRoot, journal);
    else await rollback(transactionPath, memoryRoot, journal);
    await rm(transactionPath, { recursive: true, force: true });
    recovered.push({ jobId: journal.jobId, action: terminal ? "rolled_forward" : "rolled_back" });
  }
  return recovered;
}

export async function finalizeMemoryTransaction(transactionPath) {
  if (transactionPath) await rm(transactionPath, { recursive: true, force: true });
}
