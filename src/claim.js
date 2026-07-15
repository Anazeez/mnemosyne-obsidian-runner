import { randomUUID } from "node:crypto";
import {
  mkdir,
  open,
  readFile,
  rename,
  unlink,
  writeFile
} from "node:fs/promises";
import path from "node:path";

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
  const claim = {
    schema: "ariadne.claim/v1",
    jobId: job.id,
    runnerId: options.runnerId,
    claimedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + options.leaseMs).toISOString(),
    claimPath
  };
  const handle = await open(claimPath, "wx");
  try {
    await handle.writeFile(`${JSON.stringify(claim, null, 2)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  return claim;
}

export async function claimJob(paths, job, now, options) {
  await Promise.all([
    mkdir(paths.claimsDir, { recursive: true }),
    mkdir(paths.completedDir, { recursive: true })
  ]);

  const completedPath = path.join(paths.completedDir, `${job.id}.json`);
  const completion = await readCompleted(completedPath);
  if (completion) return { status: "completed", completion };

  const claimPath = path.join(paths.claimsDir, `${job.id}.json`);
  for (;;) {
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
      if (error?.code === "ENOENT") continue;
      throw error;
    }

    if (Date.parse(existing.expiresAt) > now.getTime()) {
      return { status: "busy", claim: existing };
    }

    const expiredPath = `${claimPath}.expired-${now.getTime()}-${randomUUID()}`;
    try {
      await rename(claimPath, expiredPath);
    } catch (error) {
      if (error?.code === "ENOENT") continue;
      throw error;
    }
  }
}

export async function completeClaim(paths, claim, result) {
  await mkdir(paths.completedDir, { recursive: true });
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
  await rename(temporaryPath, completedPath);
  try {
    await unlink(claim.claimPath);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  return completion;
}
