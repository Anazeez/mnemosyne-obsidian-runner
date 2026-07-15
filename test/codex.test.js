import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Writable } from "node:stream";
import test from "node:test";

import { runCodex } from "../src/codex.js";

const job = {
  id: "ariadne-7a1e0e9c31c419e95b05b003",
  sourcePath: "Knowledge Base/Deep Work.md",
  sourceHash: "6aae19fb76074f4f73b1d2d88b1957ae65dc9e934f0f249ee53368cf9fb73bce",
  reviewMarkdown: "Approved proposal",
  capture: { content: "# Deep Work", attachments: [] }
};

async function config(spawnFn, timeoutMs = 1_000) {
  const root = await mkdtemp(path.join(os.tmpdir(), "ariadne-codex-"));
  const memoryRoot = path.join(root, "Memory");
  await mkdir(memoryRoot);
  return {
    memoryRoot,
    schemaPath: path.join(root, "schema.json"),
    tempDir: root,
    codexBin: "/usr/bin/codex",
    timeoutMs,
    spawnFn,
    parentEnv: { PATH: "/usr/bin", HOME: "/home/test", OPENAI_API_KEY: "allowed", ARIADNE_PASSKEY: "forbidden" }
  };
}

function fakeProcess(onStart) {
  return (bin, args, options) => {
    const child = new EventEmitter();
    let prompt = "";
    child.stdin = new Writable({ write(chunk, _encoding, done) { prompt += chunk; done(); } });
    child.kill = (signal) => { child.killedWith = signal; child.emit("close", null, signal); };
    queueMicrotask(() => onStart({ bin, args, options, child, prompt: () => prompt }));
    return child;
  };
}

test("invokes Codex with the exact bounded arguments and structured output", async () => {
  let invocation;
  const spawnFn = fakeProcess(async (seen) => {
    invocation = seen;
    const outputPath = seen.args[seen.args.indexOf("--output-last-message") + 1];
    await writeFile(outputPath, JSON.stringify({
      status: "completed", job_id: job.id,
      changed_files: ["index.md"], summary: "Updated Memory"
    }));
    seen.child.emit("close", 0, null);
  });
  const options = await config(spawnFn);
  const result = await runCodex(job, options);
  assert.equal(result.job_id, job.id);
  assert.equal(invocation.bin, "/usr/bin/codex");
  assert.deepEqual(invocation.args.slice(0, 8), [
    "exec", "-C", path.resolve(options.memoryRoot), "--sandbox", "workspace-write",
    "--ephemeral", "--skip-git-repo-check", "--output-schema"
  ]);
  assert.equal(invocation.args.at(-1), "-");
  assert.ok(invocation.args.includes("--output-last-message"));
  assert.ok(!invocation.args.some((arg) => ["--add-dir", "danger-full-access"].includes(arg)));
  assert.equal(invocation.options.shell, false);
  assert.equal(invocation.options.detached, true);
  assert.equal(invocation.options.env.ARIADNE_PASSKEY, undefined);
  assert.match(invocation.prompt(), /external network calls are forbidden/i);
});

test("rejects nonzero exit, invalid output, and mismatched job ID", async () => {
  const nonzero = await config(fakeProcess(({ child }) => child.emit("close", 2, null)));
  await assert.rejects(() => runCodex(job, nonzero), /execution failed/i);

  const invalid = await config(fakeProcess(async ({ args, child }) => {
    await writeFile(args[args.indexOf("--output-last-message") + 1], "not json");
    child.emit("close", 0, null);
  }));
  await assert.rejects(() => runCodex(job, invalid), /structured output/i);

  const mismatch = await config(fakeProcess(async ({ args, child }) => {
    await writeFile(args[args.indexOf("--output-last-message") + 1], JSON.stringify({
      status: "completed", job_id: "ariadne-000000000000000000000000",
      changed_files: [], summary: "done"
    }));
    child.emit("close", 0, null);
  }));
  await assert.rejects(() => runCodex(job, mismatch), /job ID/i);
});

test("terminates the process group on timeout", async () => {
  let child;
  const options = await config(fakeProcess((seen) => { child = seen.child; }), 10);
  await assert.rejects(() => runCodex(job, options), (error) => error.code === "codex_timeout");
  assert.equal(child.killedWith, "SIGTERM");
});

test("escalates to SIGKILL when a timed-out child ignores termination", async () => {
  const signals = [];
  const spawnFn = () => {
    const child = new EventEmitter();
    child.stdin = new Writable({ write(_chunk, _encoding, done) { done(); } });
    child.kill = (signal) => {
      signals.push(signal);
      if (signal === "SIGKILL") child.emit("close", null, signal);
    };
    return child;
  };
  const options = await config(spawnFn, 5);
  options.killGraceMs = 5;
  await assert.rejects(() => runCodex(job, options), (error) => error.code === "codex_timeout");
  assert.deepEqual(signals, ["SIGTERM", "SIGKILL"]);
});
