import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  createStagedMemory,
  diffTrees,
  installMemoryRules,
  snapshotTree,
  validateMemoryDiff
} from "../src/tree.js";
import { sha256 } from "../src/contracts.js";

async function root() {
  return mkdtemp(path.join(os.tmpdir(), "ariadne-tree-"));
}

async function write(rootPath, relativePath, content) {
  const target = path.join(rootPath, relativePath);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, content, "utf8");
}

const job = {
  id: "ariadne-7a1e0e9c31c419e95b05b003",
  sourcePath: "Knowledge Base/Deep Work.md",
  sourceHash: "6aae19fb76074f4f73b1d2d88b1957ae65dc9e934f0f249ee53368cf9fb73bce"
};

function page(body) {
  return `---\nid: deep-work\ntitle: Deep Work\ncreated: 2026-07-14\nstatus: canon\nsha256: ${sha256(body.trim())}\nparents: root\nsources: ${job.sourcePath}\ntags: knowledge\nschema: ariadne.memory/v1\n---\n${body}`;
}

test("snapshots are canonical, sorted, and detect changes", async () => {
  const memory = await root();
  await write(memory, "z.md", "old");
  await write(memory, "Folder/a.md", "same");
  const before = await snapshotTree(memory);
  assert.deepEqual([...before.keys()], ["Folder/a.md", "z.md"]);

  await write(memory, "z.md", "new");
  await write(memory, "b.md", "created");
  const after = await snapshotTree(memory);
  const diff = diffTrees(before, after);
  assert.deepEqual(diff.created, ["b.md"]);
  assert.deepEqual(diff.modified, ["z.md"]);
  assert.deepEqual(diff.deleted, []);
});

test("snapshots reject symlinks", async () => {
  const memory = await root();
  const outside = await root();
  await write(outside, "secret.md", "secret");
  await symlink(path.join(outside, "secret.md"), path.join(memory, "escape.md"));
  await assert.rejects(() => snapshotTree(memory), /symlink/i);
});

test("validates exactly the deterministic Memory changes", async () => {
  const memory = await root();
  await write(memory, "index.md", "# Index\n");
  await write(memory, "log.md", "# Log\n");
  const before = await snapshotTree(memory);
  const knowledge = `Knowledge/deep-work--${job.sourceHash.slice(0, 12)}.md`;
  const source = `Sources/${job.sourceHash}.md`;
  await write(memory, knowledge, page("# Deep Work\n\nConcentrated effort.\n"));
  await write(memory, source, `---\nschema: ariadne.source/v1\nsource_hash: ${job.sourceHash}\nsource_path: ${job.sourcePath}\n---\n`);
  await write(memory, "index.md", `# Index\n\n- [[${knowledge.slice(0, -3)}]]\n`);
  await write(memory, "log.md", `# Log\n\n- ${job.id}: incorporated ${job.sourcePath}\n`);
  const after = await snapshotTree(memory);

  const validated = await validateMemoryDiff(job, diffTrees(before, after), memory);
  assert.equal(validated.knowledgePath, knowledge);
  assert.equal(validated.sourceManifestPath, source);
});

test("rejects duplicate entries and deletions", async () => {
  const memory = await root();
  await write(memory, "index.md", "# Index\n");
  await write(memory, "log.md", "# Log\n");
  const before = await snapshotTree(memory);
  const knowledge = `Knowledge/deep-work--${job.sourceHash.slice(0, 12)}.md`;
  const source = `Sources/${job.sourceHash}.md`;
  await write(memory, knowledge, page("# Deep Work\n"));
  await write(memory, source, `---\nschema: ariadne.source/v1\nsource_hash: ${job.sourceHash}\nsource_path: ${job.sourcePath}\n---\n`);
  await write(memory, "index.md", `[[${knowledge}]] [[${knowledge}]]`);
  await write(memory, "log.md", `${job.id}\n${job.id}\n`);
  const diff = diffTrees(before, await snapshotTree(memory));
  await assert.rejects(() => validateMemoryDiff(job, diff, memory), /exactly once/i);

  await assert.rejects(
    () => validateMemoryDiff(job, { ...diff, deleted: ["old.md"] }, memory),
    /deletion/i
  );
});

test("rejects unexpected Memory targets", async () => {
  const memory = await root();
  await write(memory, "extra.md", "not allowed");
  await assert.rejects(
    () => validateMemoryDiff(job, { created: ["extra.md"], modified: [], deleted: [] }, memory),
    /unexpected/i
  );
});

test("installs durable Memory rules once and never overwrites them", async () => {
  const memory = await root();
  const templates = await root();
  const template = path.join(templates, "AGENTS.md");
  await writeFile(template, "approved rules", "utf8");
  assert.equal(await installMemoryRules(memory, template), true);
  await writeFile(template, "replacement", "utf8");
  assert.equal(await installMemoryRules(memory, template), false);
  assert.equal(await readFile(path.join(memory, "AGENTS.md"), "utf8"), "approved rules");
});

test("runs changes in a disposable staging copy without touching live Memory", async () => {
  const memory = await root();
  const temporary = await root();
  await write(memory, "index.md", "before");
  const staged = await createStagedMemory(memory, temporary, job.id);
  await write(staged.root, "index.md", "after");
  await write(staged.root, "Knowledge/new.md", "new page");
  assert.equal(await readFile(path.join(memory, "index.md"), "utf8"), "before");

  assert.equal(await readFile(path.join(staged.root, "index.md"), "utf8"), "after");
  assert.equal(await readFile(path.join(staged.root, "Knowledge/new.md"), "utf8"), "new page");
});

test("rejects a knowledge body whose hash does not match frontmatter", async () => {
  const memory = await root();
  const knowledge = `Knowledge/deep-work--${job.sourceHash.slice(0, 12)}.md`;
  const source = `Sources/${job.sourceHash}.md`;
  await write(memory, knowledge, page("# Original\n").replace("# Original", "# Changed"));
  await write(memory, source, `source_hash: ${job.sourceHash}`);
  await write(memory, "index.md", `[[${knowledge}]]`);
  await write(memory, "log.md", job.id);
  const after = await snapshotTree(memory);
  await assert.rejects(
    () => validateMemoryDiff(job, { created: [...after.keys()], modified: [], deleted: [] }, memory),
    /sha256/i
  );
});

test("rejects knowledge provenance that differs from the approved source", async () => {
  const memory = await root();
  const knowledge = `Knowledge/deep-work--${job.sourceHash.slice(0, 12)}.md`;
  const source = `Sources/${job.sourceHash}.md`;
  await write(memory, knowledge, page("# Deep Work\n").replace(`sources: ${job.sourcePath}`, "sources: Other.md"));
  await write(memory, source, `---\nschema: ariadne.source/v1\nsource_hash: ${job.sourceHash}\nsource_path: ${job.sourcePath}\n---\n`);
  await write(memory, "index.md", `[[${knowledge.slice(0, -3)}]]`);
  await write(memory, "log.md", job.id);
  const after = await snapshotTree(memory);
  await assert.rejects(
    () => validateMemoryDiff(job, { created: [...after.keys()], modified: [], deleted: [] }, memory),
    /provenance|source/i
  );
});
