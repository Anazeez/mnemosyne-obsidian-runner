import assert from "node:assert/strict";
import test from "node:test";

import { indexKnowledgePage } from "../src/mnemosyne.js";

const hash = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const content = `---\nsha256: ${hash}\n---\n# Knowledge`;

test("posts the knowledge page with authenticated timeout support", async () => {
  let seen;
  const fetchFn = async (url, options) => {
    seen = { url, options };
    return {
      ok: true, status: 200,
      json: async () => ({ validation: "passed", sha256: hash, results: [{ id: "section-1" }], errors: [] })
    };
  };
  const result = await indexKnowledgePage({
    workerBase: "https://worker.example/", passkey: "secret", timeoutMs: 1000, fetchFn
  }, "Knowledge/page.md", content);
  assert.equal(result.status, "succeeded");
  assert.equal(seen.url, "https://worker.example/ingest");
  assert.equal(seen.options.method, "POST");
  assert.equal(seen.options.headers["X-Matrix-Key"], "secret");
  assert.ok(seen.options.signal instanceof AbortSignal);
  assert.deepEqual(JSON.parse(seen.options.body), {
    file_name: "Knowledge/page.md", content, index_override: "knowledge"
  });
});

test("returns partial success only for validated section errors", async () => {
  const fetchFn = async () => ({
    ok: true, status: 200,
    json: async () => ({ validation: "passed", sha256: hash, results: [], errors: [{ section: "A", error: "failed" }] })
  });
  const result = await indexKnowledgePage({ workerBase: "https://worker", passkey: "x", timeoutMs: 100, fetchFn }, "page.md", content);
  assert.equal(result.status, "partial_success");
});

test("rejects invalid responses without leaking credentials", async () => {
  const fetchFn = async () => ({
    ok: false, status: 401,
    json: async () => ({ error: "Bearer secret-token sk-test-secret" })
  });
  await assert.rejects(
    () => indexKnowledgePage({ workerBase: "https://worker", passkey: "sk-passkey", timeoutMs: 100, fetchFn }, "page.md", content),
    (error) => error.code === "index_request_failed" && !/secret|sk-/i.test(error.message)
  );

  const badHash = async () => ({
    ok: true, status: 200,
    json: async () => ({ validation: "passed", sha256: "f".repeat(64), results: [], errors: [] })
  });
  await assert.rejects(
    () => indexKnowledgePage({ workerBase: "https://worker", passkey: "x", timeoutMs: 100, fetchFn: badHash }, "page.md", content),
    (error) => error.code === "index_response_invalid"
  );
});

test("aborts a timed out indexing request", async () => {
  const fetchFn = (_url, options) => new Promise((_resolve, reject) => {
    options.signal.addEventListener("abort", () => reject(options.signal.reason));
  });
  await assert.rejects(
    () => indexKnowledgePage({ workerBase: "https://worker", passkey: "x", timeoutMs: 10, fetchFn }, "page.md", content),
    (error) => error.code === "index_request_failed" && error.retryable
  );
});
