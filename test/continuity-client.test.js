import assert from "node:assert/strict";
import test from "node:test";

import {
  ContinuityClient,
  buildInvocationPackage,
  runWithContinuity,
} from "../src/continuity-client.js";

const scope = {
  identityId: "ariadne",
  projectId: "project-infinitum",
  scopeKey: "architecture",
};

function response(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function exactRehydration() {
  return {
    context: {
      status: "CURRENT_CONTEXT",
      runway_id: "rwy_exact",
      generation: 13,
      payload: { objective: "Resume exact work" },
    },
    supplemental: {
      used: true,
      results: [{ id: "old-high-score", score: 0.99 }],
      errors: [],
    },
    retrieval_receipt_id: "receipt_exact",
    invocation: {
      invocation_id: "inv_exact",
      runway_acknowledged: true,
      runway_id: "rwy_exact",
      generation: 13,
      context_status: "CURRENT_CONTEXT",
    },
  };
}

test("rehydration occurs before specialist work and preserves exact context as primary", async () => {
  const events = [];
  const fetchImpl = async (url, options) => {
    events.push(`fetch:${new URL(url).pathname}`);
    if (new URL(url).pathname === "/v1/continuity/rehydrate") {
      return response(exactRehydration());
    }
    if (new URL(url).pathname.endsWith("/complete")) {
      return response({ ok: true, continuity_outcome: "unchanged" });
    }
    throw new Error(`unexpected ${url} ${options?.method}`);
  };
  const client = new ContinuityClient({
    baseUrl: "https://worker.invalid",
    passkey: "test-key",
    fetchImpl,
  });

  const result = await runWithContinuity({
    client,
    scope,
    request: { title: "Review" },
    invoke: async (invocationPackage) => {
      events.push("specialist:invoke");
      assert.equal(invocationPackage.runway.runway_id, "rwy_exact");
      assert.equal(invocationPackage.supplemental_evidence[0].id, "old-high-score");
      assert.equal(invocationPackage.retrieval_receipt_id, "receipt_exact");
      return { output: "reviewed", continuityChanged: false };
    },
  });

  assert.deepEqual(events, [
    "fetch:/v1/continuity/rehydrate",
    "specialist:invoke",
    "fetch:/v1/continuity/invocations/inv_exact/complete",
  ]);
  assert.equal(result.context_status, "CURRENT_CONTEXT");
  assert.equal(result.completion.continuity_outcome, "unchanged");
});

test("invocation acknowledgment retains runway identity, generation, and receipt", () => {
  assert.deepEqual(buildInvocationPackage(exactRehydration()), {
    invocation_id: "inv_exact",
    runway_acknowledged: true,
    runway_id: "rwy_exact",
    generation: 13,
    context_status: "CURRENT_CONTEXT",
    runway: exactRehydration().context,
    supplemental_evidence: exactRehydration().supplemental.results,
    retrieval_receipt_id: "receipt_exact",
  });
});

test("changed continuity requires explicit checkpoint confirmation", async () => {
  const calls = [];
  const client = new ContinuityClient({
    baseUrl: "https://worker.invalid",
    passkey: "test-key",
    fetchImpl: async (url) => {
      calls.push(new URL(url).pathname);
      return response(exactRehydration());
    },
  });

  await assert.rejects(
    client.complete(exactRehydration().invocation, {
      continuityChanged: true,
      checkpointPayload: { objective: "changed" },
      submitCheckpoint: false,
    }),
    /explicit_checkpoint_confirmation_required/,
  );
  assert.deepEqual(calls, []);
});

test("explicit changed and failed completion packages remain distinct", async () => {
  const bodies = [];
  const client = new ContinuityClient({
    baseUrl: "https://worker.invalid",
    passkey: "test-key",
    fetchImpl: async (_url, options) => {
      bodies.push(JSON.parse(options.body));
      return response({ ok: true });
    },
  });

  await client.complete(exactRehydration().invocation, {
    continuityChanged: true,
    submitCheckpoint: true,
    predecessorRunwayId: "rwy_exact",
    checkpointPayload: { objective: "successor" },
    sourceHashes: [],
    idempotencyKey: "runner-successor-1",
  });
  await client.complete(exactRehydration().invocation, { checkpointFailed: true });

  assert.equal(bodies[0].continuity_changed, true);
  assert.equal(bodies[0].predecessor_runway_id, "rwy_exact");
  assert.equal(bodies[1].checkpoint_failed, true);
});

test("network failure surfaces CONTEXT_UNAVAILABLE without inventing a runway", async () => {
  const client = new ContinuityClient({
    baseUrl: "https://worker.invalid",
    passkey: "test-key",
    fetchImpl: async () => { throw new Error("private transport detail"); },
  });
  const result = await client.rehydrate(scope);
  assert.equal(result.context.status, "CONTEXT_UNAVAILABLE");
  assert.equal(result.context.runway_id, null);
  assert.equal(JSON.stringify(result).includes("private transport detail"), false);
});
