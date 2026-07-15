const ID = /^[a-z0-9][a-z0-9_-]{1,63}$/;
const PROJECT = /^[a-z0-9][a-z0-9._-]{1,63}$/;
const SCOPE = /^(?:[a-z0-9][a-z0-9_-]{1,63}|(?:mandate|thread):[a-z0-9][a-z0-9_-]{1,63})$/;

export class ContinuityClient {
  constructor({ baseUrl, passkey, fetchImpl = globalThis.fetch }) {
    this.baseUrl = String(baseUrl || "").replace(/\/+$/u, "");
    this.passkey = String(passkey || "");
    this.fetchImpl = fetchImpl;
    if (!this.baseUrl) throw new Error("continuity_base_url_required");
    if (!this.passkey) throw new Error("continuity_passkey_required");
    if (typeof this.fetchImpl !== "function") throw new Error("continuity_fetch_required");
  }

  async rehydrate(scope, {
    supplementalQuery = "",
    supplementalDomains = ["knowledge", "skills", "files"],
    topK = 5,
  } = {}) {
    const normalized = normalizeScope(scope);
    let response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}/v1/continuity/rehydrate`, {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify({
          identity_id: normalized.identityId,
          project_id: normalized.projectId,
          scope_key: normalized.scopeKey,
          supplemental_query: String(supplementalQuery || "").slice(0, 8000),
          supplemental_domains: normalizeDomains(supplementalDomains),
          top_k: Math.min(25, Math.max(1, Number(topK) || 5)),
        }),
      });
    } catch {
      return unavailableRehydration();
    }
    if (!response.ok) return unavailableRehydration(`http_${response.status}`);
    try {
      const result = await response.json();
      validateRehydration(result);
      return result;
    } catch {
      return unavailableRehydration("invalid_response");
    }
  }

  async complete(invocation, outcome = {}) {
    if (!invocation?.invocation_id) {
      return { ok: false, skipped: true, reason: "invocation_unavailable" };
    }
    let body;
    if (outcome.checkpointFailed === true) {
      body = { checkpoint_failed: true };
    } else if (outcome.continuityChanged === true) {
      if (outcome.submitCheckpoint !== true) {
        throw new Error("explicit_checkpoint_confirmation_required");
      }
      body = {
        continuity_changed: true,
        predecessor_runway_id: outcome.predecessorRunwayId,
        checkpoint_payload: outcome.checkpointPayload,
        source_hashes: outcome.sourceHashes || [],
        idempotency_key: outcome.idempotencyKey,
      };
    } else {
      body = { continuity_changed: false };
    }

    return this.requestJson(
      `/v1/continuity/invocations/${encodeURIComponent(invocation.invocation_id)}/complete`,
      { method: "POST", body: JSON.stringify(body) },
    );
  }

  headers(extra = {}) {
    return {
      "Content-Type": "application/json",
      "X-Matrix-Key": this.passkey,
      "X-Ariadne-Key": this.passkey,
      ...extra,
    };
  }

  async requestJson(path, options = {}) {
    let response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}${path}`, {
        ...options,
        headers: this.headers(options.headers),
      });
    } catch {
      throw new Error("mnemosyne_request_unavailable");
    }
    if (!response.ok) throw new Error(`mnemosyne_http_${response.status}`);
    try {
      return await response.json();
    } catch {
      throw new Error("mnemosyne_invalid_response");
    }
  }
}

export function buildInvocationPackage(rehydration) {
  validateRehydration(rehydration);
  return {
    invocation_id: rehydration.invocation.invocation_id,
    runway_acknowledged: rehydration.invocation.runway_acknowledged,
    runway_id: rehydration.invocation.runway_id,
    generation: rehydration.invocation.generation,
    context_status: rehydration.invocation.context_status,
    runway: rehydration.context,
    supplemental_evidence: [...rehydration.supplemental.results],
    retrieval_receipt_id: rehydration.retrieval_receipt_id,
  };
}

export async function runWithContinuity({
  client,
  scope,
  request,
  invoke,
  supplementalQuery = "",
  supplementalDomains,
}) {
  const rehydration = await client.rehydrate(scope, {
    supplementalQuery,
    supplementalDomains,
  });
  const invocationPackage = buildInvocationPackage(rehydration);
  const specialistResult = await invoke({ ...invocationPackage, request });
  const completion = await client.complete(rehydration.invocation, {
    continuityChanged: specialistResult.continuityChanged === true,
    checkpointFailed: specialistResult.checkpointFailed === true,
    submitCheckpoint: specialistResult.submitCheckpoint === true,
    predecessorRunwayId: specialistResult.predecessorRunwayId,
    checkpointPayload: specialistResult.checkpointPayload,
    sourceHashes: specialistResult.sourceHashes,
    idempotencyKey: specialistResult.idempotencyKey,
  });
  return {
    context_status: rehydration.context.status,
    invocation: invocationPackage,
    output: specialistResult.output,
    completion,
  };
}

function normalizeScope(scope) {
  const normalized = {
    identityId: String(scope?.identityId || "").trim().toLowerCase(),
    projectId: String(scope?.projectId || "").trim().toLowerCase(),
    scopeKey: String(scope?.scopeKey || "").trim().toLowerCase(),
  };
  if (!ID.test(normalized.identityId)) throw new Error("continuity_identity_required");
  if (!PROJECT.test(normalized.projectId)) throw new Error("continuity_project_required");
  if (!SCOPE.test(normalized.scopeKey) || normalized.scopeKey.length > 96) {
    throw new Error("continuity_scope_required");
  }
  return normalized;
}

function normalizeDomains(domains) {
  const allowed = new Set(["knowledge", "agents", "skills", "files", "library"]);
  return [...new Set(Array.isArray(domains) ? domains : [])]
    .filter((domain) => allowed.has(domain));
}

function validateRehydration(result) {
  if (!result?.context || !result?.supplemental || !result?.invocation) {
    throw new Error("invalid_rehydration_contract");
  }
  if (!Array.isArray(result.supplemental.results)) {
    throw new Error("invalid_supplemental_contract");
  }
  if (result.context.runway_id !== result.invocation.runway_id) {
    throw new Error("runway_acknowledgment_mismatch");
  }
  if (result.context.generation !== result.invocation.generation) {
    throw new Error("runway_generation_mismatch");
  }
}

function unavailableRehydration(code = "network_unavailable") {
  return {
    context: {
      status: "CONTEXT_UNAVAILABLE",
      runway_id: null,
      generation: null,
      payload: null,
      reason: "Exact continuity could not be resolved",
    },
    supplemental: {
      used: false,
      results: [],
      errors: [{ code }],
    },
    retrieval_receipt_id: null,
    invocation: {
      invocation_id: null,
      runway_acknowledged: false,
      runway_id: null,
      generation: null,
      context_status: "CONTEXT_UNAVAILABLE",
    },
  };
}
