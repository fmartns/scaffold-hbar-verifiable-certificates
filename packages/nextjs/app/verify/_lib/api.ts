/**
 * The public verifier's read-only backend port over the existing console API routes
 * (`GET /api/credentials/status`, `GET /api/credentials/audit`). This reuses the issuer console's HTTP client
 * (`../../issuer/_lib/api`) — the request timeout, envelope parsing and `IssuerError` classification are shared, not
 * re-implemented here. The verifier never calls `publish`: it has no wallet and issues nothing.
 */
import { createHttpIssuerBackend } from "../../issuer/_lib/api";
import type { ConsoleBackend } from "../../issuer/_lib/api";

export type VerifierBackend = Pick<ConsoleBackend, "status" | "audit">;

export function createVerifierBackend(fetchImpl: typeof fetch = (...args) => fetch(...args)): VerifierBackend {
  const backend = createHttpIssuerBackend(fetchImpl);
  return { status: backend.status, audit: backend.audit };
}
