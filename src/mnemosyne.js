import { RunnerError } from "./contracts.js";

function indexingError(code, message, retryable = false) {
  return new RunnerError("indexing", code, message, retryable);
}

function expectedHash(content) {
  const match = String(content).replace(/\r\n/g, "\n").match(/^---\n[\s\S]*?^sha256:\s*([0-9a-f]{64})\s*$[\s\S]*?^---$/m);
  if (!match) throw indexingError("index_response_invalid", "Knowledge page has no valid document hash.");
  return match[1];
}

export async function indexKnowledgePage(config, filePath, content) {
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(new Error("index timeout")),
    config.timeoutMs
  );
  let response;
  try {
    response = await (config.fetchFn ?? fetch)(`${config.workerBase.replace(/\/+$/g, "")}/ingest`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Matrix-Key": config.passkey
      },
      body: JSON.stringify({ file_name: filePath, content, index_override: "knowledge" }),
      signal: controller.signal
    });
  } catch (error) {
    const timedOut = controller.signal.aborted;
    throw indexingError(
      "index_request_failed",
      timedOut ? `Mnemosyne indexing timed out after ${config.timeoutMs} ms.` : "Mnemosyne indexing request failed.",
      true
    );
  } finally {
    clearTimeout(timer);
  }

  if (!response.ok) {
    throw indexingError("index_request_failed", `Mnemosyne indexing returned HTTP ${response.status}.`, response.status >= 500);
  }

  let receipt;
  try {
    receipt = await response.json();
  } catch {
    throw indexingError("index_response_invalid", "Mnemosyne indexing response was not valid JSON.");
  }
  if (!receipt || receipt.validation !== "passed" || !Array.isArray(receipt.results) ||
      !Array.isArray(receipt.errors) || receipt.sha256 !== expectedHash(content)) {
    throw indexingError("index_response_invalid", "Mnemosyne indexing response failed contract validation.");
  }
  return {
    status: receipt.errors.length ? "partial_success" : "succeeded",
    documentHash: receipt.sha256,
    results: receipt.results,
    errors: receipt.errors
  };
}
