import { randomUUID } from "node:crypto";
import { lstat, mkdir, open, readFile, readdir, realpath, rename, rm, unlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  claimJob as defaultClaimJob,
  completeClaim as defaultCompleteClaim,
  renewClaim as defaultRenewClaim,
  withClaimOwnership as defaultWithClaimOwnership
} from "./claim.js";
import { RunnerError, canonicalText, parseWorkOrder, sha256 } from "./contracts.js";
import { runCodex as defaultRunCodex } from "./codex.js";
import { indexKnowledgePage as defaultIndexKnowledgePage } from "./mnemosyne.js";
import {
  readReceipt as defaultReadReceipt,
  writeInvalidWorkOrderReport as defaultWriteInvalidWorkOrderReport,
  writeReceipt as defaultWriteReceipt
} from "./receipt.js";
import {
  diffTrees as defaultDiffTrees,
  createStagedMemory as defaultCreateStagedMemory,
  installMemoryRules as defaultInstallMemoryRules,
  snapshotTree as defaultSnapshotTree,
  validateMemoryDiff as defaultValidateMemoryDiff
} from "./tree.js";
import {
  finalizeMemoryTransaction as defaultFinalizeMemoryTransaction,
  publishMemoryTransaction as defaultPublishMemoryTransaction,
  recoverMemoryTransactions as defaultRecoverMemoryTransactions
} from "./transaction.js";

const moduleDir = path.dirname(fileURLToPath(import.meta.url));

async function acquireRunnerLock(vaultRoot) {
  const lockPath = path.join(os.tmpdir(), `ariadne-memory-writer-${sha256(vaultRoot).slice(0, 24)}.lock`);
  for (;;) {
    const token = randomUUID();
    try {
      const handle = await open(lockPath, "wx");
      try {
        await handle.writeFile(`${JSON.stringify({ token, pid: process.pid })}\n`, "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }
      return { lockPath, token };
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
    }

    let owner;
    try { owner = JSON.parse(await readFile(lockPath, "utf8")); } catch { owner = null; }
    let ownerAlive = false;
    if (Number.isInteger(owner?.pid) && owner.pid > 0) {
      try { process.kill(owner.pid, 0); ownerAlive = true; }
      catch (error) { if (error?.code !== "ESRCH") throw error; }
    }
    if (ownerAlive) return null;
    const abandoned = `${lockPath}.abandoned-${randomUUID()}`;
    try { await rename(lockPath, abandoned); }
    catch (error) { if (error?.code === "ENOENT") continue; throw error; }
    await unlink(abandoned);
  }
}

async function releaseRunnerLock(lock) {
  if (!lock) return;
  try {
    const owner = JSON.parse(await readFile(lock.lockPath, "utf8"));
    if (owner.token === lock.token) await unlink(lock.lockPath);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}

function locations(vaultRoot) {
  const runtime = path.join(vaultRoot, "System", "Ariadne", "Runtime");
  return {
    queueDir: path.join(runtime, "Queue"),
    claimsDir: path.join(runtime, "Claims"),
    completedDir: path.join(runtime, "Completed"),
    transactionsDir: path.join(runtime, "Transactions"),
    memoryRoot: path.join(vaultRoot, "System", "Ariadne", "Memory"),
    reportsDir: path.join(vaultRoot, "System", "Ariadne", "Reports")
  };
}

function within(root, candidate) {
  return candidate === root || candidate.startsWith(`${root}${path.sep}`);
}

async function ensureVaultDirectory(vaultRoot, relativePath) {
  let current = vaultRoot;
  for (const part of relativePath.split("/")) {
    current = path.join(current, part);
    try {
      const stat = await lstat(current);
      if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`Unsafe or symlinked vault directory: ${relativePath}`);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
      await mkdir(current);
    }
    const resolved = await realpath(current);
    if (!within(vaultRoot, resolved)) throw new Error(`Unsafe vault directory outside VAULT_ROOT: ${relativePath}`);
  }
}

async function prepareLocations(configuredRoot) {
  const requested = path.resolve(configuredRoot);
  const rootStat = await lstat(requested);
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) throw new Error("Unsafe or symlinked VAULT_ROOT");
  const vaultRoot = await realpath(requested);
  for (const relative of [
    "System/Ariadne/Runtime/Queue",
    "System/Ariadne/Runtime/Claims",
    "System/Ariadne/Runtime/Completed",
    "System/Ariadne/Runtime/Transactions",
    "System/Ariadne/Memory",
    "System/Ariadne/Reports"
  ]) await ensureVaultDirectory(vaultRoot, relative);
  return { vaultRoot, paths: locations(vaultRoot) };
}

async function readVaultFile(vaultRoot, relativePath) {
  let current = vaultRoot;
  for (const part of relativePath.split("/")) {
    current = path.join(current, part);
    const stat = await lstat(current);
    if (stat.isSymbolicLink()) throw new RunnerError("source_integrity", "source_path_unsafe", "Source path contains a symlink.", false);
  }
  const resolved = await realpath(current);
  if (!within(vaultRoot, resolved)) throw new RunnerError("source_integrity", "source_path_unsafe", "Source path escapes VAULT_ROOT.", false);
  return readFile(resolved, "utf8");
}

async function queueFiles(queueDir) {
  try {
    return (await readdir(queueDir, { withFileTypes: true }))
      .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
      .map((entry) => entry.name)
      .sort();
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
}

function failure(error) {
  if (error instanceof RunnerError) {
    return { stage: error.stage, code: error.code, message: error.message, retryable: error.retryable };
  }
  return { stage: "runner", code: "runner_failed", message: "The Ariadne runner failed unexpectedly.", retryable: true };
}

export async function runOne(config, supplied = {}) {
  if (!config?.vaultRoot) return { exitCode: 4, status: "fatal", message: "Missing VAULT_ROOT" };
  if (!config.workerBase || !config.passkey) {
    return { exitCode: 4, status: "fatal", message: "Missing WORKER_BASE or ARIADNE_PASSKEY" };
  }
  if (config.leaseMs < config.codexTimeoutMs + config.indexTimeoutMs + 60_000) {
    return { exitCode: 4, status: "fatal", message: "ARIADNE_LEASE_MS is too short for configured timeouts" };
  }
  let vaultRoot;
  let paths;
  try {
    ({ vaultRoot, paths } = await prepareLocations(config.vaultRoot));
  } catch (error) {
    return { exitCode: 4, status: "fatal", message: error instanceof Error ? error.message : "Unsafe VAULT_ROOT" };
  }
  let runnerLock;
  try {
    runnerLock = await acquireRunnerLock(vaultRoot);
  } catch {
    return { exitCode: 4, status: "fatal", message: "Local Memory writer lock failed." };
  }
  if (!runnerLock) return { exitCode: 2, status: "runner_busy" };

  try {
  const deps = {
    claimJob: defaultClaimJob,
    completeClaim: defaultCompleteClaim,
    renewClaim: defaultRenewClaim,
    withClaimOwnership: defaultWithClaimOwnership,
    installMemoryRules: defaultInstallMemoryRules,
    createStagedMemory: defaultCreateStagedMemory,
    publishMemoryDiff: (diff, stagedRoot, memoryRoot, before, job) =>
      defaultPublishMemoryTransaction({
        transactionRoot: paths.transactionsDir,
        jobId: job.id,
        memoryRoot,
        stagedRoot,
        before,
        diff
      }),
    recoverMemoryTransactions: defaultRecoverMemoryTransactions,
    finalizeMemoryTransaction: defaultFinalizeMemoryTransaction,
    removeStaging: (stagedRoot) => rm(stagedRoot, { recursive: true, force: true }),
    snapshotTree: defaultSnapshotTree,
    runCodex: defaultRunCodex,
    diffTrees: defaultDiffTrees,
    validateMemoryDiff: defaultValidateMemoryDiff,
    indexKnowledgePage: defaultIndexKnowledgePage,
    writeReceipt: defaultWriteReceipt,
    readReceipt: defaultReadReceipt,
    writeInvalidWorkOrderReport: defaultWriteInvalidWorkOrderReport,
    readSource: (sourcePath) => readVaultFile(vaultRoot, sourcePath),
    readMemoryFile: (root, relativePath) => readFile(path.join(root, ...relativePath.split("/")), "utf8"),
    now: () => new Date(),
    onStage: () => {},
    ...supplied
  };

  const isTerminalTransaction = async (jobId) => {
    if (await deps.readReceipt(paths.reportsDir, jobId)) return true;
    try {
      await readFile(path.join(paths.completedDir, `${jobId}.json`), "utf8");
      return true;
    } catch (error) {
      if (error?.code === "ENOENT") return false;
      throw error;
    }
  };
  try {
    await deps.recoverMemoryTransactions(
      paths.transactionsDir,
      paths.memoryRoot,
      supplied.isTerminalTransaction ?? isTerminalTransaction
    );
  } catch {
    return { exitCode: 4, status: "fatal", message: "Memory transaction recovery failed." };
  }

  const files = await queueFiles(paths.queueDir);
  if (!files.length) return { exitCode: 2, status: "no_job" };

  for (const filename of files) {
    let job;
    let workOrderMarkdown;
    try {
      workOrderMarkdown = await readFile(path.join(paths.queueDir, filename), "utf8");
      job = parseWorkOrder(workOrderMarkdown);
    } catch (error) {
      try {
        const reportPath = await deps.writeInvalidWorkOrderReport(
          paths.reportsDir,
          filename,
          workOrderMarkdown ?? "unreadable queue entry"
        );
        return { exitCode: 3, status: "failed", error: { code: "invalid_work_order" }, reportPath };
      } catch {
        return { exitCode: 4, status: "fatal", message: "Invalid work order could not be reported." };
      }
    }

    const startedAt = deps.now().toISOString();
    const stageTimestamps = {};
    let lastCompletedStage = "queued";
    const begin = (stage) => {
      deps.onStage(stage);
      stageTimestamps[stage] = deps.now().toISOString();
    };
    const completeStage = (stage) => { lastCompletedStage = stage; };

    begin("claim");
    let claimed;
    try {
      claimed = await deps.claimJob(paths, job, deps.now(), {
        runnerId: config.runnerId,
        leaseMs: config.leaseMs
      });
    } catch {
      return { exitCode: 4, status: "fatal", message: "Claim acquisition failed." };
    }
    completeStage("claim");
    if (claimed.status === "busy") continue;
    if (claimed.status === "completed") {
      return { exitCode: 0, status: "already_completed", completion: claimed.completion };
    }
    const claim = claimed.claim;

    let existingReceipt;
    try {
      existingReceipt = await deps.readReceipt(paths.reportsDir, job.id);
    } catch (error) {
      return { exitCode: 4, status: "fatal", message: error instanceof Error ? error.message : "Existing receipt is invalid." };
    }
    if (existingReceipt) {
      begin("receipt");
      completeStage("receipt");
      begin("completion");
      try {
        await deps.completeClaim(paths, claim, {
          status: existingReceipt.result.status,
          receiptPath: existingReceipt.path,
          stageTimestamps: existingReceipt.result.stageTimestamps ?? {}
        });
      } catch {
        return { exitCode: 4, status: "fatal", message: "Existing receipt was found but completion failed." };
      }
      completeStage("completion");
      return {
        exitCode: existingReceipt.result.status === "failed" ? 3 : 0,
        status: existingReceipt.result.status,
        receiptPath: existingReceipt.path,
        resumed: true
      };
    }

    let changedFiles = [];
    let validation = {};
    let indexing = { results: [], errors: [] };
    let sourcePostHash = null;
    let codexResult = null;
    let stagedRoot = null;
    let persistedTerminal = null;
    let memoryTransaction = null;

    const baseReceipt = () => ({
      job,
      startedAt,
      finishedAt: deps.now().toISOString(),
      lastCompletedStage,
      invocationId: `${job.id}:${startedAt}`,
      changedFiles,
      validation,
      indexing,
      sourcePostHash,
      stageTimestamps
    });

    try {
      begin("source_precheck");
      const sourceBefore = canonicalText(await deps.readSource(job.sourcePath));
      if (sha256(sourceBefore) !== job.sourceHash) {
        throw new RunnerError("source_integrity", "source_hash_changed", "Source note hash changed before execution.", false);
      }
      completeStage("source_precheck");

      await mkdir(paths.memoryRoot, { recursive: true });
      await deps.installMemoryRules(paths.memoryRoot, path.resolve(moduleDir, "../templates/Memory/AGENTS.md"));
      begin("snapshot");
      const staged = await deps.createStagedMemory(
        paths.memoryRoot,
        config.tempDir ?? os.tmpdir(),
        job.id
      );
      stagedRoot = staged.root;
      const before = staged.before;
      if (claimed.recoveredFrom?.memorySnapshotHash && claimed.recoveredFrom.memorySnapshotHash !== staged.digest) {
        throw new RunnerError(
          "claim",
          "recovery_snapshot_mismatch",
          "Memory changed after the expired runner recorded its pre-run snapshot.",
          false
        );
      }
      await deps.renewClaim(paths, claim, deps.now(), config.leaseMs, { memorySnapshotHash: staged.digest });
      completeStage("snapshot");

      begin("codex");
      codexResult = await deps.runCodex(job, {
        memoryRoot: stagedRoot,
        schemaPath: path.resolve(moduleDir, "../schemas/codex-result.schema.json"),
        tempDir: config.tempDir ?? os.tmpdir(),
        codexBin: config.codexBin,
        timeoutMs: config.codexTimeoutMs
      });
      await deps.renewClaim(paths, claim, deps.now(), config.leaseMs);
      completeStage("codex");

      const after = await deps.snapshotTree(stagedRoot);
      const diff = deps.diffTrees(before, after);
      begin("diff_validation");
      const validated = await deps.validateMemoryDiff(job, diff, stagedRoot);
      changedFiles = validated.changedFiles;
      validation = { boundary: "passed", schema: "passed", bodyHash: validated.bodyHash };
      completeStage("diff_validation");

      begin("memory_written");
      memoryTransaction = path.join(paths.transactionsDir, job.id);
      await deps.withClaimOwnership(paths, claim, () =>
        deps.publishMemoryDiff(diff, stagedRoot, paths.memoryRoot, before, job)
      );
      await deps.removeStaging(stagedRoot);
      stagedRoot = null;
      completeStage("memory_written");

      begin("indexing");
      const knowledge = await deps.readMemoryFile(paths.memoryRoot, validated.knowledgePath);
      indexing = await deps.indexKnowledgePage({
        workerBase: config.workerBase,
        passkey: config.passkey,
        timeoutMs: config.indexTimeoutMs
      }, validated.knowledgePath, knowledge);
      await deps.renewClaim(paths, claim, deps.now(), config.leaseMs);
      completeStage("indexing");

      begin("source_postcheck");
      const sourceAfter = canonicalText(await deps.readSource(job.sourcePath));
      sourcePostHash = sha256(sourceAfter);
      if (sourcePostHash !== job.sourceHash) {
        throw new RunnerError("source_integrity", "source_hash_changed", "Source note hash changed after execution.", false);
      }
      completeStage("source_postcheck");

      const terminalStatus = indexing.status;
      const receipt = {
        ...baseReceipt(), status: terminalStatus,
        retryable: false,
        retryableStages: terminalStatus === "partial_success" ? ["indexing"] : [],
        summary: terminalStatus === "succeeded"
          ? "Ariadne incorporated the approved snapshot without changing the source note."
          : "Ariadne wrote validated Memory artifacts, but some Mnemosyne sections require retry."
      };
      begin("receipt");
      const persisted = await deps.writeReceipt(paths.reportsDir, receipt);
      persistedTerminal = persisted;
      completeStage("receipt");

      begin("completion");
      await deps.completeClaim(paths, claim, {
        status: terminalStatus,
        receiptPath: persisted.path,
        stageTimestamps,
        codexSummary: codexResult.summary
      });
      await deps.finalizeMemoryTransaction(memoryTransaction);
      memoryTransaction = null;
      completeStage("completion");
      return { exitCode: 0, status: terminalStatus, receiptPath: persisted.path };
    } catch (error) {
      if (stagedRoot) {
        try {
          await deps.removeStaging(stagedRoot);
          stagedRoot = null;
        } catch {
          error = new RunnerError(
            "artifact_persistence",
            "staging_cleanup_failed",
            "The disposable Codex staging directory could not be removed.",
            true
          );
        }
      }
      if (persistedTerminal) {
        return {
          exitCode: 4,
          status: "fatal",
          message: "Terminal receipt was persisted but completion failed; the next run will resume completion.",
          receiptPath: persistedTerminal.path
        };
      }
      const terminalError = failure(error);
      const failedReceipt = {
        ...baseReceipt(), status: "failed", error: terminalError,
        retryable: terminalError.retryable,
        summary: terminalError.message
      };
      try {
        begin("receipt");
        const persisted = await deps.writeReceipt(paths.reportsDir, failedReceipt);
        completeStage("receipt");
        begin("completion");
        await deps.completeClaim(paths, claim, {
          status: "failed", error: terminalError, receiptPath: persisted.path, stageTimestamps
        });
        if (memoryTransaction) {
          await deps.recoverMemoryTransactions(paths.transactionsDir, paths.memoryRoot, async () => true);
          memoryTransaction = null;
        }
        completeStage("completion");
        return { exitCode: 3, status: "failed", error: terminalError, receiptPath: persisted.path };
      } catch {
        return { exitCode: 4, status: "fatal", message: "Receipt persistence or completion failed." };
      }
    }
  }
  return { exitCode: 2, status: "no_job" };
  } finally {
    try { await releaseRunnerLock(runnerLock); } catch { /* a dead-owner lock is recovered on the next run */ }
  }
}

function environmentConfig() {
  return {
    vaultRoot: process.env.VAULT_ROOT,
    runnerId: process.env.ARIADNE_RUNNER_ID || "hearken",
    leaseMs: Number(process.env.ARIADNE_LEASE_MS || 1_800_000),
    codexBin: process.env.CODEX_BIN || "codex",
    codexTimeoutMs: Number(process.env.CODEX_TIMEOUT_MS || 300_000),
    workerBase: process.env.WORKER_BASE,
    passkey: process.env.ARIADNE_PASSKEY,
    indexTimeoutMs: Number(process.env.ARIADNE_INDEX_TIMEOUT_MS || 30_000)
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try { process.loadEnvFile(); } catch (error) { if (error?.code !== "ENOENT") throw error; }
  const result = await runOne(environmentConfig());
  if (result.message) console.error(result.message);
  process.exitCode = result.exitCode;
}
