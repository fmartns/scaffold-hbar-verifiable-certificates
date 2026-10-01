import { IssuerFlowError, classifyIssuerError } from "@sh/sdk/hedera/wallet";
import type {
  CredentialAuditReportJson,
  CredentialPublishReceipt,
  CredentialStatusView,
  IssuerBackend,
  IssuerError,
} from "@sh/sdk/hedera/wallet";

type Envelope<T> = { ok: true; value: T } | { ok: false; error: IssuerError };

/** Above the server's HCS publish deadline (30 s by default) plus the registry pre-check. */
const PUBLISH_TIMEOUT_MS = 60_000;
const READ_TIMEOUT_MS = 20_000;

const deadline = (ms: number) =>
  typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function" ? AbortSignal.timeout(ms) : undefined;

async function call<T>(fetchImpl: typeof fetch, url: string, init: RequestInit, timeoutMs: number): Promise<T> {
  let response: Response;
  try {
    response = await fetchImpl(url, { ...init, signal: deadline(timeoutMs) });
  } catch (error) {
    throw new IssuerFlowError(classifyIssuerError(error));
  }
  let body: Envelope<T> | null = null;
  try {
    body = (await response.json()) as Envelope<T>;
  } catch {
    body = null;
  }
  if (body?.ok) return body.value;
  if (body && !body.ok && body.error?.category) throw new IssuerFlowError(body.error);
  throw new IssuerFlowError({
    category: "rpc_unavailable",
    code: `HTTP_${response.status}`,
    title: "Console server error",
    message: `The console server answered HTTP ${response.status} without a usable body.`,
    remediation: "Check that `yarn dev` is running and look at its logs, then retry.",
  });
}

export interface ConsoleBackend extends IssuerBackend {
  audit(credentialId: string, options?: { revocationSequence?: string }): Promise<CredentialAuditReportJson>;
}

/** The issuer flow's backend port over the console's API routes. */
export function createHttpIssuerBackend(fetchImpl: typeof fetch = (...args) => fetch(...args)): ConsoleBackend {
  return {
    publish: request =>
      call<CredentialPublishReceipt>(
        fetchImpl,
        "/api/credentials/publish",
        { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(request) },
        PUBLISH_TIMEOUT_MS,
      ),
    status: credentialId =>
      call<CredentialStatusView>(
        fetchImpl,
        `/api/credentials/status?credentialId=${encodeURIComponent(credentialId)}`,
        {},
        READ_TIMEOUT_MS,
      ),
    audit: (credentialId, options = {}) =>
      call<CredentialAuditReportJson>(
        fetchImpl,
        `/api/credentials/audit?credentialId=${encodeURIComponent(credentialId)}${
          options.revocationSequence ? `&revocationSequence=${encodeURIComponent(options.revocationSequence)}` : ""
        }`,
        {},
        READ_TIMEOUT_MS,
      ),
  };
}
