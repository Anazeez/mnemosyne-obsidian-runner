import { createHash } from "node:crypto";
import path from "node:path";

const FRONTMATTER_KEYS = new Set([
  "schema",
  "id",
  "operation",
  "status",
  "created_at",
  "approved_at",
  "source_path",
  "source_hash",
  "review_artifact",
  "review_hash",
  "allowed_domains"
]);

const SHA256 = /^[0-9a-f]{64}$/;
const JOB_ID = /^ariadne-[0-9a-f]{24}$/;

export class RunnerError extends Error {
  constructor(stage, code, message, retryable = false, details = {}) {
    super(message);
    this.name = "RunnerError";
    this.stage = stage;
    this.code = code;
    this.retryable = retryable;
    this.details = details;
  }
}

export function canonicalText(value) {
  return String(value).replace(/\r\n/g, "\n");
}

export function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function fail(message) {
  throw new RunnerError("claim", "invalid_work_order", message, false);
}

function parseScalar(value, key) {
  const trimmed = value.trim();
  if (trimmed.startsWith("\"") && trimmed.endsWith("\"")) {
    try {
      return JSON.parse(trimmed);
    } catch {
      fail(`Invalid quoted value for ${key}.`);
    }
  }
  return trimmed;
}

function parseFrontmatter(markdown) {
  const lines = canonicalText(markdown).split("\n");
  if (lines[0] !== "---") fail("Missing opening frontmatter delimiter.");
  const end = lines.indexOf("---", 1);
  if (end < 0) fail("Missing closing frontmatter delimiter.");

  const values = {};
  for (const line of lines.slice(1, end)) {
    const match = line.match(/^([a-z_]+):\s*(.*)$/);
    if (!match) fail(`Malformed frontmatter line: ${line}`);
    const [, key, raw] = match;
    if (!FRONTMATTER_KEYS.has(key)) fail(`Unknown work-order field: ${key}`);
    if (Object.hasOwn(values, key)) fail(`Duplicate work-order field: ${key}`);
    values[key] = parseScalar(raw, key);
  }

  for (const key of FRONTMATTER_KEYS) {
    if (!Object.hasOwn(values, key) || values[key] === "") fail(`Missing ${key}.`);
  }

  return values;
}

function safeVaultPath(value, field) {
  if (typeof value !== "string" || value.includes("\\")) fail(`${field} is invalid.`);
  if (path.posix.isAbsolute(value)) fail(`${field} must be vault-relative.`);
  const normalized = path.posix.normalize(value);
  if (normalized === ".." || normalized.startsWith("../") || normalized !== value) {
    fail(`${field} contains unsafe traversal or non-canonical segments.`);
  }
  return normalized;
}

function parsePayload(markdown) {
  const match = canonicalText(markdown).match(/## Payload\s+```json\n([^\n]+)\n```/);
  if (!match) fail("Missing work-order payload.");

  let payload;
  try {
    payload = JSON.parse(match[1]);
  } catch {
    fail("Work-order payload is invalid JSON.");
  }

  if (!payload || typeof payload !== "object" || Array.isArray(payload)) fail("Payload must be an object.");
  const payloadKeys = Object.keys(payload).sort();
  if (payloadKeys.join(",") !== "capture,reviewMarkdown") fail("Payload fields are invalid.");
  if (typeof payload.reviewMarkdown !== "string") fail("reviewMarkdown must be a string.");

  const capture = payload.capture;
  if (!capture || typeof capture !== "object" || Array.isArray(capture)) fail("capture must be an object.");
  const captureKeys = Object.keys(capture).sort();
  if (captureKeys.join(",") !== "attachments,content,sourceHash,sourcePath") {
    fail("Capture fields are invalid.");
  }
  if (typeof capture.content !== "string" || !Array.isArray(capture.attachments)) {
    fail("Capture content or attachments are invalid.");
  }

  return payload;
}

export function deriveJobId(operation, sourcePath, sourceHash, reviewHash) {
  const digest = sha256(JSON.stringify({
    operation,
    sourcePath,
    sourceHash: sourceHash.toLowerCase(),
    reviewHash: reviewHash.toLowerCase()
  }));
  return `ariadne-${digest.slice(0, 24)}`;
}

export function parseWorkOrder(markdown) {
  const frontmatter = parseFrontmatter(markdown);
  const payload = parsePayload(markdown);

  if (frontmatter.schema !== "ariadne.work-order/v1") fail("Unsupported work-order schema.");
  if (frontmatter.operation !== "incorporate_note") fail("Unsupported operation.");
  if (frontmatter.status !== "queued") fail("Work order is not queued.");
  if (frontmatter.allowed_domains !== "knowledge") fail("Only the knowledge domain is allowed.");
  if (!JOB_ID.test(frontmatter.id)) fail("Invalid job ID.");
  if (!SHA256.test(frontmatter.source_hash) || !SHA256.test(frontmatter.review_hash)) {
    fail("Invalid work-order hash.");
  }
  if (Number.isNaN(Date.parse(frontmatter.created_at)) || Number.isNaN(Date.parse(frontmatter.approved_at))) {
    fail("Invalid work-order timestamp.");
  }

  const sourcePath = safeVaultPath(frontmatter.source_path, "source_path");
  const reviewArtifact = safeVaultPath(frontmatter.review_artifact, "review_artifact");
  if (payload.capture.sourcePath !== sourcePath) fail("Capture source path does not match frontmatter.");
  if (payload.capture.sourceHash !== frontmatter.source_hash) fail("Capture source hash does not match frontmatter.");
  if (sha256(canonicalText(payload.capture.content)) !== frontmatter.source_hash) {
    fail("Source snapshot does not match source_hash.");
  }
  if (sha256(canonicalText(payload.reviewMarkdown)) !== frontmatter.review_hash) {
    fail("Review artifact does not match review_hash.");
  }

  const expectedId = deriveJobId(
    frontmatter.operation,
    sourcePath,
    frontmatter.source_hash,
    frontmatter.review_hash
  );
  if (frontmatter.id !== expectedId) fail("Job ID does not match approved inputs.");

  return {
    schema: "ariadne.work-order/v1",
    id: frontmatter.id,
    operation: "incorporate_note",
    status: "queued",
    createdAt: frontmatter.created_at,
    approvedAt: frontmatter.approved_at,
    sourcePath,
    sourceHash: frontmatter.source_hash,
    reviewArtifact,
    reviewHash: frontmatter.review_hash,
    allowedDomains: ["knowledge"],
    capture: payload.capture,
    reviewMarkdown: payload.reviewMarkdown
  };
}
