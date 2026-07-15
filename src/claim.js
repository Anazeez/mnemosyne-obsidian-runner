import { randomUUID } from "node:crypto";
import {
  mkdir,
  link,
  lstat,
  open,
  readFile,
  rm,
  rename,
  unlink,
  writeFile
} from "node:fs/promises";
import path from "node:path";

import { RunnerError } from "./contracts.js";

async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, "utf8"));
}

async function readCompleted(completedPath) {
  try {
    return await readJson(completedPath);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

async function createClaim(claimPath, job, now, options) {
  const storedClaim = {
    schema: "ariadne.claim/v1",
    claimId: randomUUID(),
    jobId: job.id,
    runnerId: options.runnerId,
    claimedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + options.leaseMs).toISOString()
  };
  const handle = await open(claimPath, "wx");
  try {
    await handle.writeFile(`${JSON.stringify(storedClaim, null, 2)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  return { ...storedClaim, claimPath };
}

function ownershipLockPath(paths, jobId) {
  return path.join(paths.claimsDir, ".locks", `${jobId}.lock`);
}

const OWNERSHIP_LOCK_STALE_MS = 300_000;

async function acquireOwnershipLock(paths, jobId) {
  const lockPath = ownershipLockPath(paths, jobId);
  await mkdir(path.dirname(lockPath), { recursive: true });
  const deadline = Date.now() + 5_000;
  for (;;) {
    try {
      await mkdir(lockPath);
      const token = randomUUID();
      await writeFile(path.join(lockPath, "owner.json"), `${JSON.stringify({ token, pid: process.pid })}\n`, {
        encoding: "utf8",
        flag: "wx"
      });
      return { lockPath, token };
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      try {
        const stat = await lstat(lockPath);
        if (Date.now() - stat.mtimeMs > OWNERSHIP_LOCK_STALE_MS) {
          const abandoned = `${lockPath}.abandoned-${randomUUID()}`;
          await rename(lockPath, abandoned);
          await rm(abandoned, { recursive: true, force: true });
          continue;
        }
      } catch (inspectionError) {
        if (inspectionError?.code === "ENOENT") continue;
        throw inspectionError;
      }
      if (Date.now() >= deadline) {
        throw new RunnerError("claim", "claim_lock_timeout", "Timed out waiting for the claim ownership lock.", true);
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
}

async function underOwnershipLock(paths, jobId, callback) {
  const lock = await acquireOwnershipLock(paths, jobId);
  try {
    return await callback();
  } finally {
    try {
      const owner = await readJson(path.join(lock.lockPath, "owner.json"));
      if (owner.token === lock.token) {
        await rm(lock.lockPath, { recursive: true, force: true });
      }
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
}

function activeClaim(active, claimPath) {
  return { ...active, claimPath };
}

export async function claimJob(paths, job, now, options) {
  await Promise.all([
    mkdir(paths.claimsDir, { recursive: true }),
    mkdir(paths.completedDir, { recursive: true })
  ]);

  return underOwnershipLock(paths, job.id, async () => {
    const completedPath = path.join(paths.completedDir, `${job.id}.json`);
    const completion = await readCompleted(completedPath);
    if (completion) return { status: "completed", completion };

    const claimPath = path.join(paths.claimsDir, `${job.id}.json`);
    try {
      const claim = await createClaim(claimPath, job, now, options);
      return { status: "claimed", claim };
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
    }

    let existing;
    try {
      existing = await readJson(claimPath);
    } catch (error) {
      if (error?.code === "ENOENT") {
        const claim = await createClaim(claimPath, job, now, options);
        return { status: "claimed", claim };
      }
      throw error;
    }

    if (Date.parse(existing.expiresAt) > now.getTime()) {
      return { status: "busy", claim: activeClaim(existing, claimPath) };
    }

    const expiredPath = `${claimPath}.expired-${now.getTime()}-${randomUUID()}`;
    await rename(claimPath, expiredPath);
    const claim = await createClaim(claimPath, job, now, options);
    return { status: "claimed", claim, recoveredFrom: existing };
  });
}

export async function renewClaim(paths, claim, now, leaseMs, patch = {}) {
  return underOwnershipLock(paths, claim.jobId, async () => {
    const active = await readJson(claim.claimPath);
    if (active.claimId !== claim.claimId) {
      throw new RunnerError("claim", "claim_lost", "The job lease belongs to another runner.", true);
    }
    const renewed = {
      ...active,
      ...patch,
      expiresAt: new Date(now.getTime() + leaseMs).toISOString()
    };
    const temporary = `${claim.claimPath}.renew-${claim.claimId}-${randomUUID()}`;
    await writeFile(temporary, `${JSON.stringify(renewed, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
    try {
      await rename(temporary, claim.claimPath);
    } finally {
      try { await unlink(temporary); } catch (error) { if (error?.code !== "ENOENT") throw error; }
    }
    return activeClaim(renewed, claim.claimPath);
  });
}

export async function withClaimOwnership(paths, claim, callback) {
  return underOwnershipLock(paths, claim.jobId, async () => {
    const active = await readJson(claim.claimPath);
    if (active.claimId !== claim.claimId) {
      throw new RunnerError("claim", "claim_lost", "The job lease belongs to another runner.", true);
    }
    return callback(active);
  });
}

export async function completeClaim(paths, claim, result) {
  await mkdir(paths.completedDir, { recursive: true });
  return underOwnershipLock(paths, claim.jobId, async () => {
    let active;
    try {
      active = await readJson(claim.claimPath);
    } catch (error) {
      if (error?.code === "ENOENT") {
        throw new RunnerError("claim", "claim_lost", "The active claim no longer exists.", true);
      }
      throw error;
    }
    if (!claim.claimId || active.claimId !== claim.claimId) {
      throw new RunnerError("claim", "claim_lost", "The job lease belongs to another runner.", true);
    }
    const completedPath = path.join(paths.completedDir, `${claim.jobId}.json`);
    const temporaryPath = `${completedPath}.tmp-${randomUUID()}`;
    const completion = {
      schema: "ariadne.completion/v1",
      jobId: claim.jobId,
      runnerId: claim.runnerId,
      ...result
    };

    await writeFile(temporaryPath, `${JSON.stringify(completion, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx"
    });
    try {
      await link(temporaryPath, completedPath);
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      const existing = await readJson(completedPath);
      if (JSON.stringify(existing) !== JSON.stringify(completion)) {
        throw new RunnerError("claim", "completion_conflict", "A different completion already exists.", false);
      }
    } finally {
      try { await unlink(temporaryPath); } catch (error) { if (error?.code !== "ENOENT") throw error; }
    }
    await unlink(claim.claimPath);
    return completion;
  });
}
