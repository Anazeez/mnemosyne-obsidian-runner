import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";

import { RunnerError } from "./contracts.js";

const JOB_ID = /^ariadne-[0-9a-f]{24}$/;
const ENV_ALLOWLIST = [
  "PATH", "HOME", "USER", "LOGNAME", "SHELL", "TMPDIR",
  "CODEX_HOME", "OPENAI_API_KEY", "SSL_CERT_FILE", "SSL_CERT_DIR",
  "HTTPS_PROXY", "HTTP_PROXY", "NO_PROXY"
];

function codexError(code, message, retryable = false, details = {}) {
  return new RunnerError("codex_execution", code, message, retryable, details);
}

function slug(sourcePath) {
  return path.posix.basename(sourcePath).replace(/\.md$/i, "").toLowerCase()
    .replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

function promptFor(job) {
  const knowledgePath = `Knowledge/${slug(job.sourcePath)}--${job.sourceHash.slice(0, 12)}.md`;
  const sourcePath = `Sources/${job.sourceHash}.md`;
  return `You are executing approved Ariadne job ${job.id} inside the Memory directory only.

Create or update exactly these files:
- ${knowledgePath}
- ${sourcePath}
- index.md
- log.md

Rules:
- External network calls are forbidden.
- Source-note access is forbidden; use only the approved snapshot below.
- Deletions are forbidden.
- Do not write outside the current Memory directory.
- The knowledge page must have schema ariadne.memory/v1, status canon, required ingest frontmatter, and sha256 of its body.
- Add the knowledge link to index.md exactly once.
- Append job ${job.id} to log.md exactly once.
- Preserve uncertainty; do not invent facts.

Approved source path: ${job.sourcePath}
Approved source hash: ${job.sourceHash}
Approved attachment manifest:
${JSON.stringify(job.capture.attachments, null, 2)}

Approved review:
${job.reviewMarkdown}

Approved immutable snapshot:
${job.capture.content}

Return only the structured result required by the supplied JSON schema.`;
}

function childEnv(parentEnv) {
  const env = {};
  for (const key of ENV_ALLOWLIST) if (parentEnv[key] !== undefined) env[key] = parentEnv[key];
  return env;
}

function validateResult(value, jobId) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw codexError("codex_output_invalid", "Codex structured output must be an object.");
  }
  const keys = Object.keys(value).sort().join(",");
  if (keys !== "changed_files,job_id,status,summary" || value.status !== "completed" ||
      !JOB_ID.test(value.job_id) || !Array.isArray(value.changed_files) ||
      !value.changed_files.every((file) => typeof file === "string") ||
      new Set(value.changed_files).size !== value.changed_files.length ||
      typeof value.summary !== "string" || !value.summary.length || value.summary.length > 1000) {
    throw codexError("codex_output_invalid", "Codex structured output failed schema validation.");
  }
  if (value.job_id !== jobId) throw codexError("codex_output_invalid", "Codex result job ID does not match the work order.");
  return value;
}

function terminate(child, signal) {
  if (Number.isInteger(child.pid) && child.pid > 0) {
    try { process.kill(-child.pid, signal); } catch (error) { if (error?.code !== "ESRCH") throw error; }
  } else {
    child.kill(signal);
  }
}

export async function runCodex(job, config) {
  const memoryRoot = path.resolve(config.memoryRoot);
  const schemaPath = path.resolve(config.schemaPath);
  const outputPath = path.join(path.resolve(config.tempDir), `codex-${job.id}-${randomUUID()}.json`);
  const args = [
    "exec", "-C", memoryRoot,
    "--sandbox", "workspace-write",
    "--ephemeral",
    "--skip-git-repo-check",
    "--output-schema", schemaPath,
    "--output-last-message", outputPath,
    "-"
  ];
  if (args.includes("--add-dir") || args.includes("danger-full-access")) {
    throw codexError("codex_execution_failed", "Unsafe Codex arguments were rejected.");
  }

  const spawnFn = config.spawnFn ?? spawn;
  const child = spawnFn(config.codexBin ?? "codex", args, {
    cwd: memoryRoot,
    env: childEnv(config.parentEnv ?? process.env),
    shell: false,
    detached: true,
    stdio: ["pipe", "pipe", "pipe"]
  });
  let stderr = "";
  child.stderr?.on("data", (chunk) => { stderr += String(chunk).slice(0, 4096); });

  await new Promise((resolve, reject) => {
    let finished = false;
    let timedOut = false;
    const timer = setTimeout(() => {
      if (finished) return;
      timedOut = true;
      terminate(child, "SIGTERM");
      finished = true;
      reject(codexError("codex_timeout", `Codex timed out after ${config.timeoutMs} ms.`, true));
    }, config.timeoutMs);

    child.once("error", (error) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      reject(codexError("codex_execution_failed", `Codex could not start: ${error.message}`, true));
    });
    child.once("close", (code, signal) => {
      if (finished || timedOut) return;
      finished = true;
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(codexError(
        "codex_execution_failed",
        `Codex execution failed with exit ${code ?? "null"}${signal ? ` (${signal})` : ""}.`,
        true,
        { stderr: stderr.replace(/sk-[A-Za-z0-9_-]+/g, "[redacted]") }
      ));
    });
    child.stdin.once?.("error", (error) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      reject(codexError("codex_execution_failed", `Codex input failed: ${error.message}`, true));
    });
    child.stdin.end(promptFor(job));
  });

  let parsed;
  try {
    parsed = JSON.parse(await readFile(outputPath, "utf8"));
  } catch {
    throw codexError("codex_output_invalid", "Codex structured output is missing or invalid JSON.");
  }
  return validateResult(parsed, job.id);
}
