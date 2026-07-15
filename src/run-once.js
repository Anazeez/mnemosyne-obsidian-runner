import { mkdir, readFile, readdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

import { claimJob as defaultClaimJob, completeClaim as defaultCompleteClaim } from "./claim.js";
import { RunnerError, canonicalText, parseWorkOrder, sha256 } from "./contracts.js";
import { runCodex as defaultRunCodex } from "./codex.js";
import { indexKnowledgePage as defaultIndexKnowledgePage } from "./mnemosyne.js";
import { writeReceipt as defaultWriteReceipt } from "./receipt.js";
import {
  diffTrees as defaultDiffTrees,
  installMemoryRules as defaultInstallMemoryRules,
  snapshotTree as defaultSnapshotTree,
  validateMemoryDiff as defaultValidateMemoryDiff
} from "./tree.js";

const moduleDir = path.dirname(fileURLToPath(import.meta.url));

function locations(vaultRoot) {
  const runtime = path.join(vaultRoot, "System", "Ariadne", "Runtime");
  return {
    queueDir: path.join(runtime, "Queue"),
    claimsDir: path.join(runtime, "Claims"),
    completedDir: path.join(runtime, "Completed"),
    memoryRoot: path.join(vaultRoot, "System", "Ariadne", "Memory"),
    reportsDir: path.join(vaultRoot, "System", "Ariadne", "Reports")
  };
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
  const vaultRoot = path.resolve(config.vaultRoot);
  const paths = locations(vaultRoot);
  const files = await queueFiles(paths.queueDir);
  if (!files.length) return { exitCode: 2, status: "no_job" };

  const deps = {
    claimJob: defaultClaimJob,
    completeClaim: defaultCompleteClaim,
    installMemoryRules: defaultInstallMemoryRules,
    snapshotTree: defaultSnapshotTree,
    runCodex: defaultRunCodex,
    diffTrees: defaultDiffTrees,
    validateMemoryDiff: defaultValidateMemoryDiff,
    indexKnowledgePage: defaultIndexKnowledgePage,
    writeReceipt: defaultWriteReceipt,
    readSource: (sourcePath) => readFile(path.join(vaultRoot, ...sourcePath.split("/")), "utf8"),
    readMemoryFile: (relativePath) => readFile(path.join(paths.memoryRoot, ...relativePath.split("/")), "utf8"),
    now: () => new Date(),
    onStage: () => {},
    ...supplied
  };

  for (const filename of files) {
    let job;
    try {
      job = parseWorkOrder(await readFile(path.join(paths.queueDir, filename), "utf8"));
    } catch {
      continue;
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
    const claimed = await deps.claimJob(paths, job, deps.now(), {
      runnerId: config.runnerId,
      leaseMs: config.leaseMs
    });
    completeStage("claim");
    if (claimed.status === "busy") continue;
    if (claimed.status === "completed") {
      return { exitCode: 0, status: "already_completed", completion: claimed.completion };
    }
    const claim = claimed.claim;

    let changedFiles = [];
    let validation = {};
    let indexing = { results: [], errors: [] };
    let sourcePostHash = null;
    let codexResult = null;

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
      const before = await deps.snapshotTree(paths.memoryRoot);
      completeStage("snapshot");

      begin("codex");
      codexResult = await deps.runCodex(job, {
        memoryRoot: paths.memoryRoot,
        schemaPath: path.resolve(moduleDir, "../schemas/codex-result.schema.json"),
        tempDir: config.tempDir ?? os.tmpdir(),
        codexBin: config.codexBin,
        timeoutMs: config.codexTimeoutMs
      });
      completeStage("codex");

      const after = await deps.snapshotTree(paths.memoryRoot);
      const diff = deps.diffTrees(before, after);
      begin("diff_validation");
      const validated = await deps.validateMemoryDiff(job, diff, paths.memoryRoot);
      changedFiles = validated.changedFiles;
      validation = { boundary: "passed", schema: "passed", bodyHash: validated.bodyHash };
      completeStage("diff_validation");

      begin("memory_written");
      completeStage("memory_written");

      begin("indexing");
      const knowledge = await deps.readMemoryFile(validated.knowledgePath);
      indexing = await deps.indexKnowledgePage({
        workerBase: config.workerBase,
        passkey: config.passkey,
        timeoutMs: config.indexTimeoutMs
      }, validated.knowledgePath, knowledge);
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
        retryable: terminalStatus === "partial_success",
        summary: terminalStatus === "succeeded"
          ? "Ariadne incorporated the approved snapshot without changing the source note."
          : "Ariadne wrote validated Memory artifacts, but some Mnemosyne sections require retry."
      };
      begin("receipt");
      const persisted = await deps.writeReceipt(paths.reportsDir, receipt);
      completeStage("receipt");

      begin("completion");
      await deps.completeClaim(paths, claim, {
        status: terminalStatus,
        receiptPath: persisted.path,
        stageTimestamps,
        codexSummary: codexResult.summary
      });
      completeStage("completion");
      return { exitCode: 0, status: terminalStatus, receiptPath: persisted.path };
    } catch (error) {
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
        completeStage("completion");
        return { exitCode: 3, status: "failed", error: terminalError, receiptPath: persisted.path };
      } catch {
        return { exitCode: 4, status: "fatal", message: "Receipt persistence or completion failed." };
      }
    }
  }
  return { exitCode: 2, status: "no_job" };
}

function environmentConfig() {
  return {
    vaultRoot: process.env.VAULT_ROOT,
    runnerId: process.env.ARIADNE_RUNNER_ID || "hearken",
    leaseMs: Number(process.env.ARIADNE_LEASE_MS || 600_000),
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
