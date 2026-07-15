import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

const root = path.resolve(new URL("..", import.meta.url).pathname);

test("runner source retains the Codex and secret safety boundary", async () => {
  const files = ["src/codex.js", "src/run-once.js", "src/contracts.js", "templates/Memory/AGENTS.md"];
  const source = (await Promise.all(files.map((file) => readFile(path.join(root, file), "utf8")))).join("\n");
  assert.match(source, /--sandbox[\s\S]*workspace-write/);
  assert.match(source, /ariadne\.work-order\/v1/);
  assert.match(source, /System["',\s]+Ariadne["',\s]+Memory/);
  assert.doesNotMatch(source, /vault\.modify\(|vault\.delete\(/);
  assert.doesNotMatch(source, /dangerously-bypass-approvals-and-sandbox/);
  assert.doesNotMatch(source, /["']danger-full-access["']/);
  assert.doesNotMatch(source, /["']--add-dir["']/);
  assert.doesNotMatch(source, /sk-[A-Za-z0-9_-]{12,}/);
  assert.doesNotMatch(source, /ARIADNE_PASSKEY\s*[:=]\s*["'][^"']+["']/);
});
