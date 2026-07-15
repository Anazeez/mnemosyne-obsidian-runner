import { constants } from "node:fs";
import {
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath
} from "node:fs/promises";
import path from "node:path";

import { RunnerError, canonicalText, sha256 } from "./contracts.js";

function invalid(code, message, details = {}) {
  throw new RunnerError("output_validation", code, message, false, details);
}

function inside(root, candidate) {
  return candidate === root || candidate.startsWith(`${root}${path.sep}`);
}

export async function installMemoryRules(memoryRoot, templatePath) {
  const root = await realpath(memoryRoot);
  const destination = path.join(root, "AGENTS.md");
  try {
    await copyFile(templatePath, destination, constants.COPYFILE_EXCL);
    return true;
  } catch (error) {
    if (error?.code === "EEXIST") return false;
    throw error;
  }
}

export async function snapshotTree(rootPath) {
  const root = await realpath(rootPath);
  const found = [];

  async function walk(directory) {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const absolute = path.join(directory, entry.name);
      const stat = await lstat(absolute);
      if (stat.isSymbolicLink()) invalid("write_outside_memory", `Memory contains a symlink: ${absolute}`);
      const resolved = await realpath(absolute);
      if (!inside(root, resolved)) invalid("write_outside_memory", `Path resolves outside Memory: ${absolute}`);
      if (stat.isDirectory()) {
        await walk(absolute);
      } else if (stat.isFile()) {
        const relative = path.relative(root, resolved).split(path.sep).join("/");
        if (!relative || relative.startsWith("../") || path.posix.isAbsolute(relative)) {
          invalid("write_outside_memory", `Invalid Memory path: ${relative}`);
        }
        const bytes = await readFile(resolved);
        found.push([relative, { path: relative, realPath: resolved, sha256: sha256(bytes), size: bytes.byteLength }]);
      } else {
        invalid("invalid_memory_schema", `Memory contains a non-regular file: ${absolute}`);
      }
    }
  }

  await walk(root);
  found.sort(([left], [right]) => left.localeCompare(right));
  return new Map(found);
}

export function treeDigest(tree) {
  return sha256(JSON.stringify([...tree].map(([file, snapshot]) => [file, snapshot.sha256, snapshot.size])));
}

async function ensureChildDirectory(root, relativeDirectory) {
  let current = root;
  for (const part of relativeDirectory.split("/").filter(Boolean)) {
    current = path.join(current, part);
    try {
      const stat = await lstat(current);
      if (stat.isSymbolicLink() || !stat.isDirectory()) {
        invalid("write_outside_memory", `Memory directory is unsafe: ${current}`);
      }
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
      await mkdir(current);
    }
    const resolved = await realpath(current);
    if (!inside(root, resolved)) invalid("write_outside_memory", `Memory directory escapes its root: ${current}`);
  }
}

export async function createStagedMemory(memoryRoot, temporaryRoot, jobId) {
  const liveRoot = await realpath(memoryRoot);
  await mkdir(temporaryRoot, { recursive: true });
  const stagedRoot = await mkdtemp(path.join(temporaryRoot, `ariadne-${jobId}-`));
  const before = await snapshotTree(liveRoot);
  for (const [relativePath, snapshot] of before) {
    await ensureChildDirectory(stagedRoot, path.posix.dirname(relativePath));
    await copyFile(snapshot.realPath, path.join(stagedRoot, ...relativePath.split("/")), constants.COPYFILE_EXCL);
  }
  return { root: stagedRoot, before, digest: treeDigest(before) };
}

export function diffTrees(before, after) {
  const created = [];
  const modified = [];
  const deleted = [];
  for (const [file, snapshot] of after) {
    const prior = before.get(file);
    if (!prior) created.push(file);
    else if (prior.sha256 !== snapshot.sha256 || prior.size !== snapshot.size) modified.push(file);
  }
  for (const file of before.keys()) if (!after.has(file)) deleted.push(file);
  return {
    created: created.sort(),
    modified: modified.sort(),
    deleted: deleted.sort()
  };
}

function sourceSlug(sourcePath) {
  const basename = path.posix.basename(sourcePath).replace(/\.md$/i, "");
  const slug = basename.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  if (!slug) invalid("invalid_memory_schema", "Source path cannot produce a knowledge slug.");
  return slug;
}

function parseFrontmatter(markdown) {
  const normalized = canonicalText(markdown);
  const lines = normalized.split("\n");
  if (lines[0] !== "---") invalid("invalid_memory_schema", "Knowledge page is missing frontmatter.");
  const end = lines.indexOf("---", 1);
  if (end < 0) invalid("invalid_memory_schema", "Knowledge page frontmatter is not closed.");
  const values = {};
  for (const line of lines.slice(1, end)) {
    const match = line.match(/^([a-z0-9_]+):\s*(.*)$/i);
    if (!match || Object.hasOwn(values, match[1])) {
      invalid("invalid_memory_schema", `Malformed or duplicate frontmatter: ${line}`);
    }
    values[match[1]] = match[2].trim();
  }
  return { values, body: lines.slice(end + 1).join("\n") };
}

function occurrences(text, token) {
  let count = 0;
  let from = 0;
  while ((from = text.indexOf(token, from)) >= 0) {
    count += 1;
    from += token.length;
  }
  return count;
}

async function safeRead(memoryRoot, relativePath) {
  const root = await realpath(memoryRoot);
  const target = await realpath(path.join(root, ...relativePath.split("/")));
  if (!inside(root, target)) invalid("write_outside_memory", `${relativePath} resolves outside Memory.`);
  const stat = await lstat(target);
  if (!stat.isFile() || stat.isSymbolicLink()) invalid("write_outside_memory", `${relativePath} is not a regular file.`);
  return canonicalText(await readFile(target, "utf8"));
}

export async function validateMemoryDiff(job, diff, memoryRoot) {
  if (diff.deleted.length) invalid("memory_deletion_forbidden", "Memory deletion is forbidden in v1.", { deleted: diff.deleted });
  const knowledgePath = `Knowledge/${sourceSlug(job.sourcePath)}--${job.sourceHash.slice(0, 12)}.md`;
  const sourceManifestPath = `Sources/${job.sourceHash}.md`;
  const required = [knowledgePath, sourceManifestPath, "index.md", "log.md"].sort();
  const changed = [...new Set([...diff.created, ...diff.modified])].sort();
  const unexpected = changed.filter((file) => !required.includes(file));
  const missing = required.filter((file) => !changed.includes(file));
  if (unexpected.length) invalid("write_outside_memory", `Unexpected Memory target: ${unexpected.join(", ")}`);
  if (missing.length) invalid("invalid_memory_schema", `Missing required Memory change: ${missing.join(", ")}`);

  const knowledge = await safeRead(memoryRoot, knowledgePath);
  const parsed = parseFrontmatter(knowledge);
  for (const key of ["id", "title", "created", "status", "sha256", "parents", "sources", "tags", "schema"]) {
    if (!parsed.values[key]) invalid("invalid_memory_schema", `Knowledge page is missing ${key}.`);
  }
  if (parsed.values.schema !== "ariadne.memory/v1" || parsed.values.status !== "canon") {
    invalid("invalid_memory_schema", "Knowledge page must be canon with schema ariadne.memory/v1.");
  }
  if (parsed.values.sources !== job.sourcePath) {
    invalid("invalid_memory_schema", "Knowledge page provenance does not match the approved source.");
  }
  if (!/^[0-9a-f]{64}$/.test(parsed.values.sha256) || sha256(parsed.body.trim()) !== parsed.values.sha256) {
    invalid("invalid_memory_schema", "Knowledge page sha256 does not match its body.");
  }

  const manifest = parseFrontmatter(await safeRead(memoryRoot, sourceManifestPath)).values;
  if (manifest.schema !== "ariadne.source/v1" || manifest.source_hash !== job.sourceHash ||
      manifest.source_path !== job.sourcePath) {
    invalid("invalid_memory_schema", "Source manifest does not match the approved source.");
  }

  const index = await safeRead(memoryRoot, "index.md");
  const linkTarget = knowledgePath.slice(0, -3);
  const links = occurrences(index, `[[${linkTarget}]]`) + occurrences(index, `[[${knowledgePath}]]`);
  if (links !== 1) invalid("missing_index_update", "Index must contain the knowledge page link exactly once.");
  const log = await safeRead(memoryRoot, "log.md");
  if (occurrences(log, job.id) !== 1) invalid("missing_log_entry", "Log must contain the job ID exactly once.");

  return { knowledgePath, sourceManifestPath, changedFiles: changed, bodyHash: parsed.values.sha256 };
}
