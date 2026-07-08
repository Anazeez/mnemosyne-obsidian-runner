import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import "dotenv/config";

const VAULT_ROOT = process.env.VAULT_ROOT;
const ARIADNE_PASSKEY = process.env.ARIADNE_PASSKEY;

const WORKER_BASE =
  "https://mnemosyne-worker.izeesub.workers.dev";

const MODE = process.argv[2] || "intake";
const ENDPOINT =
  MODE === "review"
    ? `${WORKER_BASE}/api/ariadne/core/review`
    : `${WORKER_BASE}/api/ariadne/core/intake`;

if (!VAULT_ROOT) throw new Error("Missing VAULT_ROOT in .env");
if (!ARIADNE_PASSKEY) throw new Error("Missing ARIADNE_PASSKEY in .env");

const inboxDir = path.join(VAULT_ROOT, "Inbox");
const reviewDir = path.join(VAULT_ROOT, "System", "Ariadne", "Review");

function stripMd(filename) {
  return filename.replace(/\.md$/i, "");
}

function mdList(items = []) {
  if (!items.length) return "- None";
  return items.map((item) => `- ${item}`).join("\n");
}

function makeReviewMarkdown(originalPath, response) {
  const proposal = response.proposal ?? response.review ?? {};

  return `# Ariadne ${MODE === "review" ? "Review" : "Intake"} Proposal

## Original file path

${originalPath}

## Classification

${proposal.classification ?? "Unclassified"}

## Summary

${proposal.summary ?? ""}

## Proposed destination

${proposal.proposedDestination ?? ""}

## Proposed tags

${mdList(proposal.proposedTags)}

## Proposed links

${mdList(proposal.proposedLinks)}

## Warnings

${mdList(proposal.warnings)}

## Safety

- mutated: false
- approval required: true
`;
}

async function main() {
  await fs.mkdir(reviewDir, { recursive: true });

  const entries = await fs.readdir(inboxDir, { withFileTypes: true });

  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".md")) continue;

    const filePath = path.join(inboxDir, entry.name);
    const content = await fs.readFile(filePath, "utf8");

    const payload =
      MODE === "review"
        ? {
            title: stripMd(entry.name),
            content,
            currentLocation: `Inbox/${entry.name}`,
            metadata: {
              vaultPath: `Inbox/${entry.name}`
            },
            reviewFirst: true
          }
        : {
            title: stripMd(entry.name),
            content,
            source: "obsidian",
            metadata: {
              vaultPath: `Inbox/${entry.name}`
            },
            reviewFirst: true
          };

    const res = await fetch(ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Matrix-Key": ARIADNE_PASSKEY
      },
      body: JSON.stringify(payload)
    });

    if (!res.ok) {
      console.error(`Failed: ${entry.name} — HTTP ${res.status}`);
      console.error(await res.text());
      continue;
    }

    const data = await res.json();

    if (data.mutated !== false || data.reviewFirst !== true) {
      console.error(`Unsafe response skipped: ${entry.name}`);
      continue;
    }

    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const reviewPath = path.join(reviewDir, `${MODE}-${stamp}-${entry.name}`);
    const reviewMarkdown = makeReviewMarkdown(`Inbox/${entry.name}`, data);

    await fs.writeFile(reviewPath, reviewMarkdown, "utf8");

    console.log(`Created review: ${reviewPath}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
