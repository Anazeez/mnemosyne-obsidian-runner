import { randomUUID } from "node:crypto";
import { link, mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

import { RunnerError, sha256 } from "./contracts.js";

function redactString(value) {
  return value
    .replace(/Bearer\s+\S+/gi, "Bearer [redacted]")
    .replace(/sk-[A-Za-z0-9_-]+/g, "[redacted-key]");
}

function redact(value, key = "") {
  if (/passkey|secret|token|authorization/i.test(key)) return "[redacted]";
  if (typeof value === "string") return redactString(value);
  if (Array.isArray(value)) return value.map((item) => redact(item));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([childKey, child]) => [childKey, redact(child, childKey)]));
  }
  return value;
}

function yaml(value) {
  return JSON.stringify(redactString(String(value)));
}

export function formatReceipt(result) {
  const safe = redact({
    ...result,
    job: {
      id: result.job.id,
      sourcePath: result.job.sourcePath,
      sourceHash: result.job.sourceHash,
      reviewArtifact: result.job.reviewArtifact,
      reviewHash: result.job.reviewHash
    }
  });
  return `---
schema: ariadne.receipt/v1
job_id: ${yaml(safe.job.id)}
source_path: ${yaml(safe.job.sourcePath)}
source_hash: ${yaml(safe.job.sourceHash)}
review_artifact: ${yaml(safe.job.reviewArtifact)}
review_hash: ${yaml(safe.job.reviewHash)}
started_at: ${yaml(safe.startedAt)}
finished_at: ${yaml(safe.finishedAt)}
status: ${safe.status}
last_completed_stage: ${yaml(safe.lastCompletedStage)}
retryable: ${Boolean(safe.retryable)}
---
# Ariadne action receipt

${safe.summary}

## Details

\`\`\`json
${JSON.stringify(safe, null, 2)}
\`\`\`
`;
}

export async function readReceipt(reportsDir, jobId) {
  const receiptPath = path.join(reportsDir, `receipt-${jobId}.md`);
  let markdown;
  try {
    markdown = await readFile(receiptPath, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
  const match = markdown.match(/## Details\s+```json\n([\s\S]+?)\n```/);
  if (!match) throw new RunnerError("receipt", "receipt_invalid", "Existing receipt has no valid detail block.", false);
  let result;
  try { result = JSON.parse(match[1]); } catch {
    throw new RunnerError("receipt", "receipt_invalid", "Existing receipt details are invalid JSON.", false);
  }
  if (result?.job?.id !== jobId || !["succeeded", "partial_success", "failed"].includes(result?.status)) {
    throw new RunnerError("receipt", "receipt_invalid", "Existing receipt does not match the job.", false);
  }
  return { path: receiptPath, result };
}

export async function writeReceipt(reportsDir, result) {
  await mkdir(reportsDir, { recursive: true });
  const content = formatReceipt(result);
  const receiptPath = path.join(reportsDir, `receipt-${result.job.id}.md`);
  try {
    const existing = await readFile(receiptPath, "utf8");
    if (existing === content) return { path: receiptPath, duplicate: true };
    throw new RunnerError("receipt", "receipt_conflict", "A different terminal receipt already exists.", false);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }

  const temporaryPath = path.join(reportsDir, `.receipt-${result.job.id}-${randomUUID()}.tmp`);
  await writeFile(temporaryPath, content, { encoding: "utf8", flag: "wx" });
  try {
    await link(temporaryPath, receiptPath);
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
    const existing = await readFile(receiptPath, "utf8");
    if (existing !== content) {
      throw new RunnerError("receipt", "receipt_conflict", "A different terminal receipt already exists.", false);
    }
    return { path: receiptPath, duplicate: true };
  } finally {
    try { await unlink(temporaryPath); } catch (error) { if (error?.code !== "ENOENT") throw error; }
  }
  return { path: receiptPath, duplicate: false };
}

export async function writeInvalidWorkOrderReport(reportsDir, filename, markdown) {
  await mkdir(reportsDir, { recursive: true });
  const identity = sha256(markdown).slice(0, 16);
  const reportPath = path.join(reportsDir, `invalid-work-order-${identity}.md`);
  const content = `---
schema: ariadne.invalid-work-order/v1
status: failed
code: invalid_work_order
queue_file: ${JSON.stringify(filename)}
content_hash: ${sha256(markdown)}
---
# Invalid Ariadne work order

The queue entry failed strict contract validation. Its content is not copied into
this diagnostic. Correct or remove it only after preserving evidence.
`;
  try {
    await writeFile(reportPath, content, { encoding: "utf8", flag: "wx" });
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
    if (await readFile(reportPath, "utf8") !== content) {
      throw new RunnerError("receipt", "receipt_conflict", "Invalid-work-order diagnostic conflicts with existing content.", false);
    }
  }
  return reportPath;
}
