import "server-only";
import { CertificateError, CertificateService, isHolder, loadCertificatesConfig } from "@sh/sdk/certificates";
import type { HolderLabel } from "@sh/sdk/certificates";

/**
 * One CertificateService per server process. Kept on `globalThis` so Next.js dev reloads reuse the open wallets
 * instead of opening the same SQLite files twice.
 */
const cache = globalThis as unknown as { certificateService?: Promise<CertificateService> };

export function certificateService(): Promise<CertificateService> {
  if (!cache.certificateService) {
    cache.certificateService = loadCertificatesConfig(process.env).then(config => new CertificateService(config));
    cache.certificateService.catch(() => (cache.certificateService = undefined));
  }
  return cache.certificateService;
}

const STATUS: Record<CertificateError["code"], number> = {
  INVALID_INPUT: 400,
  NOT_FOUND: 404,
  ISSUER_NOT_INITIALIZED: 409,
  REGISTRY_FULL: 409,
  PROOF_UNAVAILABLE: 422,
  DOCUMENT_INVALID: 422,
  LEDGER_READ_FAILED: 502,
  LEDGER_WRITE_FAILED: 502,
};

/** Runs a route body; typed failures become `{ error: { code, message } }` with a matching status. */
export async function respond(body: () => Promise<unknown>): Promise<Response> {
  try {
    const result = await body();
    return result instanceof Response ? result : Response.json(result);
  } catch (error) {
    if (error instanceof CertificateError) {
      return Response.json({ error: { code: error.code, message: error.message } }, { status: STATUS[error.code] });
    }
    // Unknown failures are logged server-side without request data and reported generically.
    console.error("certificate route failed:", error instanceof Error ? error.name : typeof error);
    return Response.json({ error: { code: "INTERNAL", message: "Unexpected server error." } }, { status: 500 });
  }
}

export function holderFrom(value: unknown): HolderLabel {
  if (!isHolder(value)) throw new CertificateError("INVALID_INPUT", "holder must be one of the demo holders.");
  return value;
}
