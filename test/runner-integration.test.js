import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { processInbox } from "../ariadne-intake-review.js";

test("runner rehydrates before intake, forwards the receipt, and records unchanged completion", async () => {
  const vaultRoot = await mkdtemp(path.join(tmpdir(), "mnemosyne-runner-"));
  const inbox = path.join(vaultRoot, "Inbox");
  await mkdir(inbox, { recursive: true });
  const notePath = path.join(inbox, "continuity.md");
  await writeFile(notePath, "Exact continuity must remain primary.", "utf8");
  const events = [];
  const client = {
    async rehydrate(scope) {
      events.push(["rehydrate", scope]);
      return {
        context: { status: "CURRENT_CONTEXT", runway_id: "rwy_exact", generation: 8, payload: {} },
        supplemental: { used: false, results: [], errors: [] },
        retrieval_receipt_id: "receipt_exact",
        invocation: {
          invocation_id: "inv_exact",
          runway_acknowledged: true,
          runway_id: "rwy_exact",
          generation: 8,
          context_status: "CURRENT_CONTEXT",
        },
      };
    },
    async complete(invocation, outcome) {
      events.push(["complete", invocation.invocation_id, outcome]);
      return { ok: true, continuity_outcome: "unchanged" };
    },
  };

  const result = await processInbox({
    vaultRoot,
    continuityClient: client,
    scope: {
      identityId: "ariadne",
      projectId: "project-infinitum",
      scopeKey: "architecture",
    },
    intake: async ({ payload, receiptId }) => {
      events.push(["intake", receiptId, payload.title]);
      return {
        mutated: false,
        reviewFirst: true,
        proposal: {
          classification: "continuity",
          summary: "Reviewed with exact context",
          proposedDestination: "Projects/Mnemosyne",
          proposedTags: [],
          proposedLinks: [],
          warnings: [],
        },
      };
    },
  });

  assert.deepEqual(events.map(([event]) => event), ["rehydrate", "intake", "complete"]);
  assert.equal(events[1][1], "receipt_exact");
  assert.equal(events[2][2].continuityChanged, false);
  assert.equal(result.processed, 1);
  assert.equal(await readFile(notePath, "utf8"), "Exact continuity must remain primary.");
  const reviews = await readdir(path.join(vaultRoot, "System", "Ariadne", "Review"));
  assert.equal(reviews.length, 1);
});

test("runner records checkpoint failure when intake fails after successful rehydration", async () => {
  const vaultRoot = await mkdtemp(path.join(tmpdir(), "mnemosyne-runner-"));
  await mkdir(path.join(vaultRoot, "Inbox"), { recursive: true });
  await writeFile(path.join(vaultRoot, "Inbox", "failure.md"), "content", "utf8");
  const completions = [];
  const client = {
    async rehydrate() {
      return {
        context: { status: "CURRENT_CONTEXT", runway_id: "rwy", generation: 1 },
        supplemental: { used: false, results: [], errors: [] },
        retrieval_receipt_id: "receipt",
        invocation: { invocation_id: "inv", runway_id: "rwy", generation: 1 },
      };
    },
    async complete(_invocation, outcome) { completions.push(outcome); },
  };
  const result = await processInbox({
    vaultRoot,
    continuityClient: client,
    scope: { identityId: "ariadne", projectId: "project-infinitum", scopeKey: "default" },
    intake: async () => { throw new Error("private upstream detail"); },
  });

  assert.equal(result.failed, 1);
  assert.deepEqual(completions, [{ checkpointFailed: true }]);
  assert.equal(JSON.stringify(result).includes("private upstream detail"), false);
});

test("runtime configuration requires explicit continuity scope and has no embedded endpoint", async () => {
  const packageJson = JSON.parse(await readFile("package.json", "utf8"));
  const example = await readFile(".env.example", "utf8");
  const source = await readFile("ariadne-intake-review.js", "utf8");
  assert.equal(packageJson.scripts.test, "node --test test/*.test.js");
  for (const name of [
    "WORKER_BASE",
    "CONTINUITY_IDENTITY_ID",
    "CONTINUITY_PROJECT_ID",
    "CONTINUITY_SCOPE_KEY",
  ]) {
    assert.match(example, new RegExp(`^${name}=`, "m"));
  }
  assert.doesNotMatch(source, /workers\.dev/);
  assert.doesNotMatch(source, /await res\.text\(\)/);
  assert.doesNotMatch(source, /Created intake proposal: \$\{reviewPath\}/);
});
