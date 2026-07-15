import { randomUUID } from "node:crypto";
import { link, mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

import { RunnerError } from "./contracts.js";

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
  const safe = redact(result);
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
