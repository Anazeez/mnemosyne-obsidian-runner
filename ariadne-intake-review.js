import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import "dotenv/config";

import {
  ContinuityClient,
  buildInvocationPackage,
} from "./src/continuity-client.js";

function stripMd(filename) {
  return filename.replace(/\.md$/iu, "");
}

function mdList(items = []) {
  if (!Array.isArray(items) || items.length === 0) return "- None";
  return items.map((item) => `- ${String(item)}`).join("\n");
}

function makeReviewMarkdown(originalPath, response, continuity) {
  const proposal = response.proposal || {};
  return `# Ariadne Intake Proposal

## Original file path

${originalPath}

## Exact contextual continuity

- status: ${continuity.context_status}
- runway: ${continuity.runway_id || "None"}
- generation: ${continuity.generation ?? "None"}
- retrieval receipt: ${continuity.retrieval_receipt_id || "Unavailable"}
- supplemental evidence kept separate: true

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
- checkpoint submitted automatically: false
`;
}

export async function processInbox({
  vaultRoot,
  continuityClient,
  scope,
  intake,
}) {
  const inboxDir = path.join(vaultRoot, "Inbox");
  const reviewDir = path.join(vaultRoot, "System", "Ariadne", "Review");
  await fs.mkdir(reviewDir, { recursive: true });
  const entries = await fs.readdir(inboxDir, { withFileTypes: true });
  const result = { processed: 0, failed: 0, skipped: 0 };

  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".md")) {
      result.skipped += 1;
      continue;
    }

    const filePath = path.join(inboxDir, entry.name);
    const content = await fs.readFile(filePath, "utf8");
    const vaultPath = `Inbox/${entry.name}`;
    const rehydration = await continuityClient.rehydrate(scope, {
      supplementalQuery: stripMd(entry.name),
      supplementalDomains: ["knowledge", "skills", "files"],
    });
    const invocation = buildInvocationPackage(rehydration);
    const payload = {
      title: stripMd(entry.name),
      content,
      source: "obsidian-runner",
      metadata: {
        vaultPath,
        originalLocation: vaultPath,
        continuity: {
          runway: invocation.runway,
          supplemental_evidence: invocation.supplemental_evidence,
          retrieval_receipt_id: invocation.retrieval_receipt_id,
        },
      },
      reviewFirst: true,
    };

    try {
      const data = await intake({
        payload,
        receiptId: invocation.retrieval_receipt_id,
      });
      if (data.mutated !== false || data.reviewFirst !== true || !data.proposal) {
        throw new Error("unsafe_or_invalid_ariadne_response");
      }
      const stamp = new Date().toISOString().replace(/[:.]/gu, "-");
      const reviewPath = path.join(reviewDir, `intake-${stamp}-${entry.name}`);
      await fs.writeFile(
        reviewPath,
        makeReviewMarkdown(vaultPath, data, invocation),
        "utf8",
      );
      await continuityClient.complete(rehydration.invocation, {
        continuityChanged: false,
      });
      result.processed += 1;
      console.log(`Created intake proposal: ${path.basename(reviewPath)}`);
    } catch {
      await continuityClient.complete(rehydration.invocation, {
        checkpointFailed: true,
      });
      result.failed += 1;
      console.error(`Ariadne intake failed safely: ${entry.name}`);
    }
  }

  return result;
}

function requiredEnvironment(name) {
  const value = String(process.env[name] || "").trim();
  if (!value) throw new Error(`Missing ${name} in runtime environment`);
  return value;
}

export async function main() {
  const vaultRoot = requiredEnvironment("VAULT_ROOT");
  const passkey = requiredEnvironment("ARIADNE_PASSKEY");
  const baseUrl = requiredEnvironment("WORKER_BASE");
  const scope = {
    identityId: requiredEnvironment("CONTINUITY_IDENTITY_ID"),
    projectId: requiredEnvironment("CONTINUITY_PROJECT_ID"),
    scopeKey: requiredEnvironment("CONTINUITY_SCOPE_KEY"),
  };
  const continuityClient = new ContinuityClient({ baseUrl, passkey });
  return processInbox({
    vaultRoot,
    continuityClient,
    scope,
    intake: ({ payload, receiptId }) => continuityClient.requestJson(
      "/api/ariadne/core/intake",
      {
        method: "POST",
        headers: receiptId ? { "X-Continuity-Receipt": receiptId } : {},
        body: JSON.stringify(payload),
      },
    ),
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => {
    console.error("Runner failed with a bounded error.");
    process.exitCode = 1;
  });
}
