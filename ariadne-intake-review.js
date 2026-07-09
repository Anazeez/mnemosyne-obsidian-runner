import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import "dotenv/config";

const VAULT_ROOT = process.env.VAULT_ROOT;
const ARIADNE_PASSKEY = process.env.ARIADNE_PASSKEY;
const WORKER_BASE =
  process.env.WORKER_BASE || "https://mnemosyne-worker.izeesub.workers.dev";

const ENDPOINT = `${WORKER_BASE}/api/ariadne/core/intake`;

if (!VAULT_ROOT) {
  throw new Error("Missing VAULT_ROOT in .env");
}

if (!ARIADNE_PASSKEY) {
  throw new Error("Missing ARIADNE_PASSKEY in .env");
}

const inboxDir = path.join(VAULT_ROOT, "Inbox");
const reviewDir = path.join(VAULT_ROOT, "System", "Ariadne", "Review");

function stripMd(filename) {
  return filename.replace(/\.md$/i, "");
}

function mdList(items = []) {
  if (!Array.isArray(items) || items.length === 0) {
    return "- None";
  }

  return items.map((item) => `- ${String(item)}`).join("\n");
}

function makeReviewMarkdown(originalPath, response) {
  const proposal = response.proposal || {};

  return `# Ariadne Intake Proposal

## Original file path

${originalPath}

## Classification

${proposal.classification || "Unclassified"}

## Summary

${proposal.summary || ""}

## Proposed destination

${proposal.proposedDestination || ""}

## Proposed tags

${mdList(proposal.proposedTags)}

## Proposed links

${mdList(proposal.proposedLinks)}

## Warnings

${mdList(proposal.warnings)}

## Safety

- reviewFirst: true
- mutated: false
- approval required: true
- original note moved: false
- original note renamed: false
- original note deleted: false
- direct vault knowledge mutation: false
`;
}

async function main() {
  await fs.mkdir(reviewDir, { recursive: true });

  const entries = await fs.readdir(inboxDir, { withFileTypes: true });

  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".md")) {
      continue;
    }

    const filePath = path.join(inboxDir, entry.name);
    const content = await fs.readFile(filePath, "utf8");
    const vaultPath = `Inbox/${entry.name}`;

    const payload = {
      title: stripMd(entry.name),
      content,
      source: "obsidian-runner",
      metadata: {
        vaultPath,
        originalLocation: vaultPath
      },
      reviewFirst: true
    };

    const res = await fetch(ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Matrix-Key": ARIADNE_PASSKEY,
        "X-Ariadne-Key": ARIADNE_PASSKEY
      },
      body: JSON.stringify(payload)
    });

    if (!res.ok) {
      console.error(`Failed: ${entry.name} — HTTP ${res.status}`);
      console.error(await res.text());
      continue;
    }

    const data = await res.json();

    if (data.mutated !== false || data.reviewFirst !== true || !data.proposal) {
      console.error(`Unsafe or invalid Ariadne response skipped: ${entry.name}`);
      console.error(JSON.stringify(data, null, 2));
      continue;
    }

    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const reviewPath = path.join(reviewDir, `intake-${stamp}-${entry.name}`);
    const reviewMarkdown = makeReviewMarkdown(vaultPath, data);

    await fs.writeFile(reviewPath, reviewMarkdown, "utf8");

    console.log(`Created intake proposal: ${reviewPath}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});