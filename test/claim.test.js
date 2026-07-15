import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, utimes } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { claimJob, completeClaim, renewClaim, withClaimOwnership } from "../src/claim.js";

const job = { id: "ariadne-7a1e0e9c31c419e95b05b003" };

async function pathsForTest() {
  const root = await mkdtemp(path.join(os.tmpdir(), "ariadne-claim-"));
  return {
    claimsDir: path.join(root, "Claims"),
    completedDir: path.join(root, "Completed")
  };
}

test("only one concurrent runner claims a job", async () => {
  const paths = await pathsForTest();
  const now = new Date("2026-07-14T12:00:00.000Z");
  const [left, right] = await Promise.all([
    claimJob(paths, job, now, { runnerId: "left", leaseMs: 60_000 }),
    claimJob(paths, job, now, { runnerId: "right", leaseMs: 60_000 })
  ]);

  assert.deepEqual(
    [left.status, right.status].sort(),
    ["busy", "claimed"]
  );
});

test("an expired lease can be reclaimed", async () => {
  const paths = await pathsForTest();
  const first = await claimJob(
    paths,
    job,
    new Date("2026-07-14T12:00:00.000Z"),
    { runnerId: "first", leaseMs: 1_000 }
  );
  assert.equal(first.status, "claimed");

  const second = await claimJob(
    paths,
    job,
    new Date("2026-07-14T12:00:02.000Z"),
    { runnerId: "second", leaseMs: 1_000 }
  );
  assert.equal(second.status, "claimed");
  assert.equal(second.claim.runnerId, "second");
});

test("completion is durable before the claim is removed", async () => {
  const paths = await pathsForTest();
  const result = await claimJob(
    paths,
    job,
    new Date("2026-07-14T12:00:00.000Z"),
    { runnerId: "hearken", leaseMs: 60_000 }
  );
  assert.equal(result.status, "claimed");

  await completeClaim(paths, result.claim, { status: "succeeded" });
  const completedPath = path.join(paths.completedDir, `${job.id}.json`);
  const completed = JSON.parse(await readFile(completedPath, "utf8"));
  assert.equal(completed.status, "succeeded");

  const repeated = await claimJob(
    paths,
    job,
    new Date("2026-07-14T12:01:00.000Z"),
    { runnerId: "other", leaseMs: 60_000 }
  );
  assert.equal(repeated.status, "completed");
});

test("an expired runner cannot complete or remove its replacement claim", async () => {
  const paths = await pathsForTest();
  const stale = await claimJob(
    paths,
    job,
    new Date("2026-07-14T12:00:00.000Z"),
    { runnerId: "stale", leaseMs: 1_000 }
  );
  const replacement = await claimJob(
    paths,
    job,
    new Date("2026-07-14T12:00:02.000Z"),
    { runnerId: "replacement", leaseMs: 60_000 }
  );
  assert.equal(replacement.status, "claimed");
  await assert.rejects(
    () => completeClaim(paths, stale.claim, { status: "succeeded" }),
    (error) => error.code === "claim_lost"
  );
  const busy = await claimJob(
    paths,
    job,
    new Date("2026-07-14T12:00:03.000Z"),
    { runnerId: "third", leaseMs: 60_000 }
  );
  assert.equal(busy.status, "busy");
  assert.equal(busy.claim.runnerId, "replacement");
});

test("lease renewal prevents recovery and ownership gates publication", async () => {
  const paths = await pathsForTest();
  const first = await claimJob(
    paths, job, new Date("2026-07-14T12:00:00.000Z"),
    { runnerId: "first", leaseMs: 1_000 }
  );
  await renewClaim(
    paths, first.claim, new Date("2026-07-14T12:00:00.500Z"), 10_000,
    { memorySnapshotHash: "snapshot-a" }
  );
  const second = await claimJob(
    paths, job, new Date("2026-07-14T12:00:02.000Z"),
    { runnerId: "second", leaseMs: 1_000 }
  );
  assert.equal(second.status, "busy");
  assert.equal(second.claim.memorySnapshotHash, "snapshot-a");
  assert.equal(await withClaimOwnership(paths, first.claim, () => "published"), "published");
});

test("recovers an abandoned short-lived ownership lock", async () => {
  const paths = await pathsForTest();
  const lockPath = path.join(paths.claimsDir, ".locks", `${job.id}.lock`);
  await mkdir(lockPath, { recursive: true });
  await utimes(lockPath, new Date(0), new Date(0));
  const result = await claimJob(
    paths, job, new Date("2026-07-14T12:00:00.000Z"),
    { runnerId: "recovery", leaseMs: 60_000 }
  );
  assert.equal(result.status, "claimed");
});
