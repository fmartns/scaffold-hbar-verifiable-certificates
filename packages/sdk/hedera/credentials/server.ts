/**
 * Server side of the issuer console, framework-agnostic: the Next.js routes only parse the request and return what
 * these handlers produce. Each handler answers `{ status, body }` with a JSON-safe body and classifies every failure
 * as an {@link IssuerError}.
 *
 * The publish handler spends operator HBAR, so it only publishes a message that (1) is a valid, canonical credential
 * message for the configured registry and (2) is signed by the CURRENT signer of an ACTIVE registered issuer (for a
 * revocation: of the issuer that issued the credential, which must still be issued). Anyone else is refused before
 * anything is sent, which is also what makes "issuer not registered" a specific, early error.
 *
 * An issuance must also pin `submitter`: once published, the signed event is public, and with `submitter = 0` anyone
 * could front-run `issue` with a forged `HcsRef` (docs/security.md T-5/F-1). The server refuses to make such an event
 * public.
 */
import type { EnvironmentVariables } from "../environment";
import { auditCredential } from "../audit/audit";
import { CredentialAuditConfigError, createCredentialAuditContext, loadCredentialAuditConfig } from "../audit/config";
import { RegistryReadError, callRegistry, createCredentialStatusReader } from "../audit/registry";
import type { CredentialAuditReport } from "../audit/types";
import { buildCredentialMessage } from "../hcs/credential-envelope";
import type { CredentialMessage } from "../hcs/credential-envelope";
import { classifyPublishError, isHcsPublishError } from "../hcs/errors";
import type { HcsTransport } from "../hcs/publisher";
import { getSelectedNetwork } from "../networks";
import type { HederaNetwork } from "../networks";
import { loadCredentialPublisherConfig } from "./config";
import type { CredentialPublisherConfig } from "./config";
import { describeRegistryError, fromHcsPublishFailure } from "./errors";
import type { IssuerError } from "./errors";
import { isCredentialId, pinnedSubmitter } from "./fields";
import type { CredentialPublishReceipt, CredentialStatusView, IssuerConsoleSettings } from "./issuer-flow";
import { createCredentialPublisherFromEnv } from "./publisher";
import { decodeIssuerOfResult, encodeIssuerOfCall } from "./registry-calls";

/** Upper bound of the Mirror polling of one console audit request. */
export const CONSOLE_AUDIT_POLL_MS = 8_000;

export type HandlerResponse<T> = { status: number; body: { ok: true; value: T } | { ok: false; error: IssuerError } };

export interface ServerDeps {
  env: EnvironmentVariables;
  fetch?: typeof fetch;
  /** Overrides the HCS transport (tests); no Hedera client is created then. */
  transport?: HcsTransport;
  now?: () => Date;
}

const fail = <T>(status: number, error: IssuerError): HandlerResponse<T> => ({ status, body: { ok: false, error } });

function notConfigured<T>(issues: { variable: string; message: string }[]): HandlerResponse<T> {
  return fail(503, {
    category: "not_configured",
    code: "NOT_CONFIGURED",
    title: "Issuer console not configured",
    message: issues.map(i => i.message).join(" "),
    remediation: `Set ${[...new Set(issues.map(i => i.variable))].join(", ")} in .env (see docs/issuer-console.md), then restart the server.`,
  });
}

function registryUnavailable(error: unknown): IssuerError {
  if (error instanceof RegistryReadError && error.reason === "not_registry") {
    return {
      category: "not_configured",
      code: "NOT_A_REGISTRY",
      title: "Registry address is wrong",
      message: "HEDERA_CREDENTIAL_REGISTRY_ADDRESS does not answer like a CredentialRegistry on the selected network.",
      remediation: "Check the address and HEDERA_NETWORK (open /dashboard for a full diagnosis).",
    };
  }
  return {
    category: "rpc_unavailable",
    code: "REGISTRY_UNAVAILABLE",
    title: "JSON-RPC relay unreachable",
    message: "The server could not read CredentialRegistry over the JSON-RPC relay. Nothing was published.",
    remediation: "Retry in a few seconds. If it persists, check HEDERA_RPC_URL (open /dashboard).",
  };
}

const invalid = (message: string, issues?: { field: string; message: string }[]): IssuerError => ({
  category: "invalid_input",
  code: "INVALID_REQUEST",
  title: "Invalid request",
  message,
  remediation: "Reload the console and try again.",
  ...(issues && { issues }),
});

/** Who may have the message published: the active issuer's current signer (see the module comment). */
export async function authorizePublication(
  message: CredentialMessage,
  config: CredentialPublisherConfig,
  fetchImpl?: typeof fetch,
): Promise<IssuerError | null> {
  const options = { network: config.network, registryAddress: config.registryAddress, fetch: fetchImpl };
  let issuer = message.kind === "issuance" ? message.event.issuer : message.revocation.issuer;
  if (message.kind === "revocation") {
    const record = await createCredentialStatusReader(options).statusOf(message.derived.credentialId);
    if (record.status === "not_found") {
      return describeRegistryError({ name: "UnknownCredential", args: { credentialId: message.derived.credentialId } });
    }
    if (record.status === "revoked") {
      return describeRegistryError({
        name: "AlreadyRevoked",
        args: { credentialId: message.derived.credentialId, revokedAt: record.revokedAt.toString() },
      });
    }
    if (record.issuer !== issuer) return invalid("The revocation names another issuer than the one that issued it.");
    issuer = record.issuer;
  }
  const cfg = decodeIssuerOfResult(await callRegistry(options, encodeIssuerOfCall(issuer)));
  if (!cfg.registered) return describeRegistryError({ name: "UnknownIssuer", args: { issuer } });
  if (!cfg.active) return describeRegistryError({ name: "InactiveIssuer", args: { issuer } });
  if (cfg.signer !== message.derived.signer) {
    return message.kind === "issuance"
      ? describeRegistryError({
          name: "UnauthorizedSigner",
          args: { recovered: message.derived.signer, expected: cfg.signer },
        })
      : describeRegistryError({
          name: "UnauthorizedRevoker",
          args: { credentialId: message.derived.credentialId, caller: message.derived.signer },
        });
  }
  return null;
}

/** `POST /api/credentials/publish`. */
export async function handlePublishCredential(
  body: unknown,
  deps: ServerDeps,
): Promise<HandlerResponse<CredentialPublishReceipt>> {
  const loaded = loadCredentialPublisherConfig(deps.env);
  if (!loaded.ok) return notConfigured(loaded.issues);
  const { config } = loaded;

  const request = (typeof body === "object" && body !== null ? body : {}) as Record<string, unknown>;
  if (request.kind !== "issuance" && request.kind !== "revocation") {
    return fail(400, invalid("kind must be issuance or revocation."));
  }
  const built = buildCredentialMessage(
    request.kind === "issuance"
      ? { kind: "issuance", event: request.event, signature: String(request.signature ?? "") }
      : { kind: "revocation", revocation: request.revocation, signature: String(request.signature ?? "") },
    { chainId: config.network.chainId, verifyingContract: config.registryAddress },
  );
  if (!built.ok) {
    return fail(
      400,
      invalid(
        "The signed credential message is invalid. Nothing was published.",
        built.issues.map(i => ({ field: i.field, message: i.message })),
      ),
    );
  }
  if (built.value.kind === "issuance" && !pinnedSubmitter(built.value.event.submitter)) {
    return fail(400, {
      category: "invalid_input",
      code: "SUBMITTER_NOT_PINNED",
      title: "Issuance not pinned to its sender",
      message:
        "The signed issuance lets any account submit it (submitter = 0). Once on HCS anyone could front-run it with a forged HcsRef. Nothing was published.",
      remediation: "Sign the issuance again with submitter set to the account that sends the registry transaction.",
      issues: [{ field: "submitter", message: "submitter must be the sending account, not the zero address." }],
    });
  }

  try {
    const refused = await authorizePublication(built.value, config, deps.fetch);
    if (refused) return fail(refused.category === "issuer_not_registered" ? 403 : 409, refused);
  } catch (error) {
    const classified = registryUnavailable(error);
    return fail(classified.category === "not_configured" ? 503 : 502, classified);
  }

  let handle;
  try {
    handle = await createCredentialPublisherFromEnv(deps.env, config, deps);
  } catch (error) {
    const failure = isHcsPublishError(error) ? error.failure : classifyPublishError(error);
    return fail(503, fromHcsPublishFailure(failure));
  }
  try {
    const result = await handle.publisher.publish(built.value);
    if (!result.ok) {
      const error = fromHcsPublishFailure(result.error);
      return fail(error.category === "timeout" ? 504 : 502, error);
    }
    const { ok: _ok, ...receipt } = result;
    void _ok;
    return { status: 200, body: { ok: true, value: receipt } };
  } finally {
    handle.close();
  }
}

/** `GET /api/credentials/status?credentialId=`: `statusOf`, the authority on a credential's state. */
export async function handleCredentialStatus(
  credentialId: string,
  deps: ServerDeps,
): Promise<HandlerResponse<CredentialStatusView>> {
  const loaded = loadCredentialPublisherConfig(deps.env, { requireOperator: false });
  if (!loaded.ok) return notConfigured(loaded.issues);
  if (!isCredentialId(credentialId))
    return fail(400, invalid("credentialId must be 0x followed by 64 hex characters."));
  const id = credentialId.trim().toLowerCase() as CredentialStatusView["credentialId"];
  try {
    const record = await createCredentialStatusReader({
      network: loaded.config.network,
      registryAddress: loaded.config.registryAddress,
      fetch: deps.fetch,
    }).statusOf(id);
    return {
      status: 200,
      body: {
        ok: true,
        value: {
          credentialId: id,
          status: record.status,
          issuer: record.issuer,
          signer: record.signer,
          issuedAt: record.issuedAt.toString(),
          revokedAt: record.revokedAt.toString(),
        },
      },
    };
  } catch (error) {
    const classified = registryUnavailable(error);
    return fail(classified.category === "not_configured" ? 503 : 502, classified);
  }
}

export function issuerConsoleSettings(env: EnvironmentVariables): IssuerConsoleSettings {
  const loaded = loadCredentialPublisherConfig(env);
  if (loaded.ok) {
    const { network, registryAddress, topicId } = loaded.config;
    return {
      configured: true,
      issues: [],
      network: network.name,
      chainId: network.chainId,
      registryAddress,
      topicId,
      hashscanUrl: network.hashscanUrl,
    };
  }
  let network: HederaNetwork | null = null;
  try {
    network = getSelectedNetwork(env);
  } catch {
    network = null;
  }
  return {
    configured: false,
    issues: loaded.issues,
    network: network?.name ?? null,
    chainId: network?.chainId ?? null,
    registryAddress: null,
    topicId: null,
    hashscanUrl: network?.hashscanUrl ?? null,
  };
}

/** Deep copy with every `bigint` as a decimal string, so a report can be sent as JSON. */
export function toJsonSafe<T>(value: T): unknown {
  return JSON.parse(JSON.stringify(value, (_key, v) => (typeof v === "bigint" ? v.toString() : v)));
}

/** `GET /api/credentials/audit?credentialId=`: the shared audit report (#10), as JSON. */
export async function handleCredentialAudit(
  credentialId: string,
  deps: ServerDeps & { pollTimeoutMs?: number; revocationHcsSequence?: string },
): Promise<HandlerResponse<unknown>> {
  let config;
  try {
    config = loadCredentialAuditConfig(deps.env);
  } catch (error) {
    if (error instanceof CredentialAuditConfigError) return notConfigured(error.issues);
    throw error;
  }
  if (!isCredentialId(credentialId))
    return fail(400, invalid("credentialId must be 0x followed by 64 hex characters."));
  // A request must stay short: the console asks again while the report says `pending_index`.
  const ctx = createCredentialAuditContext(
    { ...config, pollTimeoutMs: Math.min(config.pollTimeoutMs, deps.pollTimeoutMs ?? CONSOLE_AUDIT_POLL_MS) },
    { fetch: deps.fetch },
  );
  const sequence = deps.revocationHcsSequence;
  const report: CredentialAuditReport = await auditCredential(credentialId.trim().toLowerCase(), ctx, {
    ...(sequence && /^[1-9]\d*$/.test(sequence) && { revocationHcsSequence: BigInt(sequence) }),
  });
  return { status: 200, body: { ok: true, value: toJsonSafe(report) } };
}
