/**
 * The HTS settlement adapter: the single integration layer with the Hedera Token Service (issue #7).
 *
 * What runs where (ADR-001 §6.7, D9, D12):
 *  - ON-CHAIN, in the `SettlementRouter` (#9): replay protection, and the mint -> transfer of the credit through the HTS
 *    system contract, atomically with the "processed" mark. The router is the single enforcement point and the only holder
 *    of the supply key in production. A contract cannot call this TypeScript, so the adapter is its off-chain counterpart:
 *    `preflight` (what a relayer checks before `settle`), `associate` (the account-side step the router cannot do),
 *    `planOperations`/`expectedEffects` (the spec the router and the audit are checked against), and the interpretation
 *    of HTS results (`decodeHtsFailed`, error normalization).
 *  - OFF-CHAIN, `settle`: executes the operations itself. Only possible under OPERATOR custody (dev/test), where the
 *    operator is treasury and supply key. It is refused with router custody and on mainnet.
 *
 * Idempotency (ADR D4/D5, coordinated with the router): the key is `eventKey`; `settlementId` and `contentHash` travel with
 * it. A repeat is detected, in this order, by (1) the router's `statusOf` (authority), (2) the caller's ledger, (3) the
 * settlement memo on Mirror Node. Same key + same content and already complete => the previous result is returned and NOTHING
 * is sent. Same key + different content => `CONFLICTING_SETTLEMENT`, never executed. Rejected => a legitimate retry.
 * Unknown => not resent until it can be shown the transaction expired (valid duration is at most 180 s).
 * The adapter itself holds no state and never retries by itself.
 */
import type { PublicKeyCandidate } from "../environment";
import { hashscanTokenUrl, hashscanTransactionUrl, toMirrorTransactionId } from "../explorer";
import type { HtsAdapterConfig } from "./config";
import { HtsTimeoutError, classifyHtsError } from "./errors";
import type { HtsErrorContext, HtsFailure } from "./errors";
import type { HtsExecutor } from "./executor";
import { createHtsMirror } from "./mirror";
import type { HtsMirror, SettlementTransaction } from "./mirror";
import { runHtsPreflight } from "./preflight";
import type { HtsPreflightResult } from "./preflight";
import { expectedEffects, planOperations, settlementMemo, validateSettlementInput } from "./settlement";
import type { NormalizedSettlement, SettlementStep } from "./settlement";
import type {
  AssociateResult,
  IdempotencyLedger,
  LedgerRecord,
  LedgerStep,
  OperationResult,
  SettleResult,
  SettlementFailure,
  SettlementStatusReader,
  SettlementSuccess,
} from "./types";

/** Valid duration of a transaction is at most 180 s; Mirror Node may lag by about a minute on top. */
export const UNKNOWN_STEP_EXPIRY_MS = 4 * 60_000;
const DEFAULT_LOOKBACK_SECONDS = 24 * 3600;

export interface HtsAdapterOptions {
  config: HtsAdapterConfig;
  /** Sends the operations. Optional: without it the adapter is preflight-only (what a router-custody relayer needs). */
  executor?: HtsExecutor;
  /** The caller's persistence. Optional second line of defense; see the module comment. */
  ledger?: IdempotencyLedger;
  /** The router's `statusOf`: the authority on whether an event was settled. Strongly recommended. */
  statusReader?: SettlementStatusReader;
  mirror?: HtsMirror;
  fetch?: typeof fetch;
  /** Public keys the operator signs with (operator custody), for the mint-permission check. */
  operatorKeys?: PublicKeyCandidate[];
  /** Deadline of one HTS operation. Default 30 000 ms. */
  timeoutMs?: number;
  /** How far back to look for the settlement memo when there is no ledger record. Default 24 h. */
  lookbackSeconds?: number;
  now?: () => Date;
}

export interface HtsSettlementAdapter {
  readonly config: HtsAdapterConfig;
  /** Validates the input and checks every precondition against Mirror Node. Sends nothing. */
  preflight(input: unknown): Promise<PreflightOutcome>;
  /** Checks only the token and the custody setup (exists, usable, treasury, supply key), for startup validation. */
  checkSetup(): Promise<HtsPreflightResult>;
  /** Associates an account with the token (idempotent). Needs an executor and the account's own key. */
  associate(request: { accountId: string; tokenId?: string }): Promise<AssociateResult>;
  /** Executes the settlement (operator custody only). Never throws for HTS problems; never retries by itself. */
  settle(input: unknown): Promise<SettleResult>;
}

export type PreflightOutcome =
  ({ valid: true } & HtsPreflightResult) | { valid: false; ok: false; failure: HtsFailure };

const failed = (failure: HtsFailure): SettlementFailure => ({ ok: false, status: "failed", failure });

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new HtsTimeoutError(timeoutMs)), timeoutMs);
  });
  promise.catch(() => undefined); // the operation keeps running after a timeout; never an unhandled rejection
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
}

export function createHtsSettlementAdapter(options: HtsAdapterOptions): HtsSettlementAdapter {
  const { config, executor, ledger, statusReader } = options;
  const mirror = options.mirror ?? createHtsMirror(config.network, { fetch: options.fetch });
  const now = options.now ?? (() => new Date());
  const timeoutMs = options.timeoutMs ?? 30_000;
  const inFlight = new Map<string, Promise<SettleResult>>();

  function ctxOf(
    s: NormalizedSettlement,
    operation: HtsErrorContext["operation"],
    extra: Partial<HtsErrorContext> = {},
  ): HtsErrorContext {
    return {
      operation,
      tokenId: s.tokenId,
      amount: s.amount.toString(),
      idempotencyKey: s.eventKey,
      settlementId: s.settlementId,
      timeoutMs,
      ...extra,
    };
  }

  const stamp = (failure: HtsFailure, s: NormalizedSettlement): HtsFailure => ({
    ...failure,
    idempotencyKey: s.eventKey,
    settlementId: s.settlementId,
    tokenId: failure.tokenId ?? s.tokenId,
  });

  function operationResult(
    operation: OperationResult["operation"],
    transactionId: string,
    consensusTimestamp: string,
  ): OperationResult {
    return {
      operation,
      transactionId,
      mirrorTransactionId: toMirrorTransactionId(transactionId),
      consensusTimestamp,
      hashscanUrl: consensusTimestamp ? hashscanTransactionUrl(config.network, consensusTimestamp) : null,
    };
  }

  function success(
    s: NormalizedSettlement,
    args: {
      status: SettlementSuccess["status"];
      source: SettlementSuccess["source"];
      operations: OperationResult[];
      to: string;
      preflight?: HtsPreflightResult;
      routerSettledAt?: string;
    },
  ): SettlementSuccess {
    const last = args.operations[args.operations.length - 1];
    const treasury = config.treasuryId ?? null;
    return {
      ok: true,
      status: args.status,
      replay: args.source !== "executed",
      source: args.source,
      idempotencyKey: s.eventKey,
      settlementId: s.settlementId,
      contentHash: s.contentHash,
      network: config.network.name,
      tokenId: s.tokenId,
      model: config.model,
      custody: config.custody,
      from: treasury,
      to: args.to,
      amount: s.amount.toString(),
      operations: args.operations,
      transactionId: last?.transactionId ?? null,
      hashscanUrl: last?.hashscanUrl ?? null,
      hashscanTokenUrl: hashscanTokenUrl(config.network, s.tokenId),
      audit: {
        schema: "hts-settlement/v1",
        expectedEffects: expectedEffects(config.model, {
          treasury: treasury ?? "",
          beneficiary: args.to,
          amount: s.amount,
        }),
        recordedAt: now().toISOString(),
        preflight: {
          checks: (args.preflight?.checks ?? []).filter(c => c.ok).map(c => c.id),
          warnings: (args.preflight?.checks ?? []).filter(c => c.severity === "warning").map(c => c.message),
        },
        ...(args.routerSettledAt && { routerSettledAt: args.routerSettledAt }),
      },
    };
  }

  /** Steps that Mirror Node shows as applied, keyed by step. */
  const appliedSteps = (found: SettlementTransaction[]) => {
    const applied: Partial<Record<SettlementStep, SettlementTransaction>> = {};
    for (const tx of found) if (tx.result === "SUCCESS") applied[tx.step] = applied[tx.step] ?? tx;
    return applied;
  };
  const fromMirror = (tx: SettlementTransaction) =>
    operationResult(tx.step, sdkTransactionId(tx.transactionId), tx.consensusTimestamp);

  // ------------------------------------------------------------------------------------------------------------------
  // preflight
  // ------------------------------------------------------------------------------------------------------------------

  async function preflight(input: unknown): Promise<PreflightOutcome> {
    const parsed = validateSettlementInput(input);
    if (!parsed.ok) {
      return {
        valid: false,
        ok: false,
        failure: {
          code: "INVALID_SETTLEMENT",
          outcome: "not_sent",
          operation: "preflight",
          message: `The settlement input is invalid: ${parsed.issues.map(i => `${i.field}: ${i.message}`).join(" ")}`,
          remediation: "Fix the listed fields. Nothing was sent.",
          retryable: false,
          issues: parsed.issues,
        },
      };
    }
    try {
      const result = await runHtsPreflight({
        config,
        mirror,
        settlement: parsed.value,
        operatorKeys: options.operatorKeys,
      });
      return { valid: true, ...result, ...(result.failure && { failure: stamp(result.failure, parsed.value) }) };
    } catch (error) {
      return {
        valid: false,
        ok: false,
        failure: stamp(classifyHtsError(error, ctxOf(parsed.value, "preflight")), parsed.value),
      };
    }
  }

  async function checkSetup(): Promise<HtsPreflightResult> {
    // The beneficiary is not examined: any well-formed placeholder satisfies the input shape.
    const settlement: NormalizedSettlement = {
      eventKey: `0x${"00".repeat(31)}01`,
      settlementId: `0x${"00".repeat(31)}01`,
      contentHash: `0x${"00".repeat(31)}01`,
      tokenId: config.tokenId,
      beneficiary: "0.0.1",
      amount: 1n,
    };
    try {
      return await runHtsPreflight({ config, mirror, settlement, operatorKeys: options.operatorKeys, tokenOnly: true });
    } catch (error) {
      const failure = classifyHtsError(error, { operation: "preflight", tokenId: config.tokenId, timeoutMs });
      return { ok: false, checks: [], failure };
    }
  }

  // ------------------------------------------------------------------------------------------------------------------
  // associate
  // ------------------------------------------------------------------------------------------------------------------

  async function associate(request: { accountId: string; tokenId?: string }): Promise<AssociateResult> {
    const tokenId = request.tokenId ?? config.tokenId;
    const ctx: HtsErrorContext = { operation: "associate", tokenId, accountId: request.accountId, timeoutMs };
    try {
      const token = await mirror.getToken(tokenId);
      if (!token || token.deleted) {
        return failed(
          classifyHtsError(
            { name: "PrecheckStatusError", status: token ? "TOKEN_WAS_DELETED" : "INVALID_TOKEN_ID" },
            ctx,
          ),
        );
      }
      const account = await mirror.getAccount(request.accountId);
      if (!account || account.deleted)
        return failed(classifyHtsError({ name: "PrecheckStatusError", status: "INVALID_ACCOUNT_ID" }, ctx));
      const existing = await mirror.getRelationship(account.accountId, tokenId);
      const base = {
        accountId: account.accountId,
        tokenId,
        network: config.network.name,
        hashscanTokenUrl: hashscanTokenUrl(config.network, tokenId),
      };
      if (existing) return { ok: true, status: "already_associated", operation: null, ...base };
      if (!executor) {
        return failed({
          code: "CONFIG_INVALID",
          outcome: "not_sent",
          operation: "associate",
          message: "No executor is configured, so this process cannot send the association.",
          remediation:
            "Create the adapter with an executor, or have the account owner associate the token from its wallet.",
          retryable: false,
          accountId: account.accountId,
          tokenId,
        });
      }
      let transactionId: string | undefined;
      let receipt;
      try {
        receipt = await withTimeout(
          executor.associate({
            accountId: account.accountId,
            tokenId,
            memo: "hvs:1:associate",
            timeoutMs,
            onTransactionId: id => (transactionId = id),
          }),
          timeoutMs,
        );
      } catch (error) {
        return failed(classifyHtsError(error, { ...ctx, ...(transactionId && { transactionId }) }));
      }
      if (receipt.alreadyAssociated) return { ok: true, status: "already_associated", operation: null, ...base };
      return {
        ok: true,
        status: "associated",
        operation: operationResult("associate", receipt.transactionId, receipt.consensusTimestamp),
        ...base,
      };
    } catch (error) {
      return failed(classifyHtsError(error, ctx));
    }
  }

  // ------------------------------------------------------------------------------------------------------------------
  // settle
  // ------------------------------------------------------------------------------------------------------------------

  async function run(s: NormalizedSettlement): Promise<SettleResult> {
    if (config.custody !== "operator" || !executor) {
      return failed(
        stamp(
          {
            code: "CONFIG_INVALID",
            outcome: "not_sent",
            operation: "settle",
            message:
              config.custody === "router"
                ? "With router custody the SettlementRouter mints and transfers on-chain; this process cannot execute the settlement."
                : "No executor is configured, so this process cannot send HTS operations.",
            remediation:
              config.custody === "router"
                ? "Call preflight() and then SettlementRouter.settle (#9). Use HEDERA_HTS_CUSTODY=operator with an executor only for development on Testnet."
                : "Create the adapter with an executor (createHieroHtsExecutor).",
            retryable: false,
          },
          s,
        ),
      );
    }
    const treasury = config.treasuryId as string;
    const plan = planOperations(config.model, {
      tokenId: s.tokenId,
      treasury,
      beneficiary: s.beneficiary,
      amount: s.amount,
    });

    // A zero amount is the ADR's valid no-op: it consumes the key and touches no token.
    if (plan.length === 0) {
      return success(s, { status: "noop", source: "executed", operations: [], to: s.beneficiary });
    }

    // 1. The router is the AUTHORITY (ADR §5.5): ask it before anything else.
    if (statusReader) {
      try {
        const status = await statusReader.statusOf(s.eventKey);
        if (status.settled) {
          if (status.contentHash.toLowerCase() !== s.contentHash) return failed(conflict(s, "the router"));
          return success(s, {
            status: "already_settled",
            source: "router",
            operations: [],
            to: s.beneficiary,
            routerSettledAt: String(status.settledAt),
          });
        }
      } catch (error) {
        return failed(stamp(classifyHtsError(error, ctxOf(s, "settle")), s));
      }
    }

    // 2. The caller's ledger.
    let record: LedgerRecord | null = null;
    if (ledger) {
      record = await ledger.get(s.eventKey);
      if (record) {
        if (record.contentHash !== s.contentHash) return failed(conflict(s, "an earlier attempt"));
        if (record.state === "completed" && record.result) {
          return { ...record.result, status: "already_settled", replay: true, source: "ledger" };
        }
      }
    }

    // 3. The network: the settlement memo shows what was really applied, whatever the ledger believes.
    let applied: Partial<Record<SettlementStep, SettlementTransaction>> = {};
    try {
      const since = record
        ? Math.floor(Date.parse(record.createdAt) / 1000) - 60
        : Math.floor(now().getTime() / 1000) - (options.lookbackSeconds ?? DEFAULT_LOOKBACK_SECONDS);
      applied = appliedSteps(await mirror.findSettlementTransactions(treasury, s.eventKey, since));
    } catch (error) {
      return failed(stamp(classifyHtsError(error, ctxOf(s, "settle")), s));
    }
    const lastStep = plan[plan.length - 1].step;
    if (applied[lastStep]) {
      const operations = plan
        .map(p => applied[p.step])
        .filter((t): t is SettlementTransaction => Boolean(t))
        .map(fromMirror);
      const result = success(s, { status: "already_settled", source: "network", operations, to: s.beneficiary });
      await finish(record, s, result);
      return result;
    }

    // Another attempt is running right now (its record was touched within the expiry window): do not start a second one.
    if (record?.state === "in_progress" && now().getTime() - Date.parse(record.updatedAt) < UNKNOWN_STEP_EXPIRY_MS) {
      return failed(
        stamp(
          {
            code: "SETTLEMENT_IN_PROGRESS",
            outcome: "unknown",
            operation: "settle",
            message: "Another attempt for this settlement is in progress.",
            remediation:
              "Do not resend it. Call settle again in a moment: it will return the result of the other attempt.",
            retryable: true,
          },
          s,
        ),
      );
    }

    // An earlier attempt with an unknown outcome that Mirror does not show yet: wait until it has certainly expired.
    for (const step of plan) {
      const previous = record?.steps[step.step];
      if (previous && (previous.state === "unknown" || previous.state === "sent") && !applied[step.step]) {
        const age = previous.sentAt ? now().getTime() - Date.parse(previous.sentAt) : 0;
        if (age < UNKNOWN_STEP_EXPIRY_MS) {
          return failed(
            stamp(
              {
                code: "SETTLEMENT_IN_PROGRESS",
                outcome: "unknown",
                operation: step.step,
                message: `An earlier ${step.step} for this settlement has an unknown outcome and is not visible on Mirror Node yet.`,
                remediation: `Do not resend it. Wait about ${Math.ceil((UNKNOWN_STEP_EXPIRY_MS - age) / 1000)} s and call settle again with the same input: the adapter then finds it or knows it expired. Transaction: ${previous.transactionId ?? "unknown"}.`,
                retryable: true,
                ...(previous.transactionId && { transactionId: previous.transactionId }),
              },
              s,
            ),
          );
        }
      }
    }

    // 4. Preconditions: never send what a lookup already shows would be rejected.
    const mintApplied = Boolean(applied.mint) || record?.steps.mint?.state === "confirmed";
    let pre: HtsPreflightResult;
    try {
      pre = await runHtsPreflight({
        config,
        mirror,
        settlement: s,
        operatorKeys: options.operatorKeys,
        skipMint: mintApplied,
      });
    } catch (error) {
      return failed(stamp(classifyHtsError(error, ctxOf(s, "preflight")), s));
    }
    const appliedTxIds = () =>
      (["mint", "transfer"] as const)
        .map(k => applied[k]?.transactionId ?? record?.steps[k]?.transactionId)
        .filter((id): id is string => Boolean(id));
    if (!pre.ok && pre.failure) {
      const failure = stamp(pre.failure, s);
      return failed(mintApplied ? { ...failure, outcome: "partial", appliedTransactions: appliedTxIds() } : failure);
    }
    const beneficiary = pre.beneficiaryAccountId ?? s.beneficiary;

    // 5. Claim the key before sending, so a concurrent retry sees it.
    const at = now().toISOString();
    if (!record) {
      if (ledger) {
        const begun = await ledger.begin({
          idempotencyKey: s.eventKey,
          settlementId: s.settlementId,
          contentHash: s.contentHash,
          state: "in_progress",
          steps: {},
          createdAt: at,
          updatedAt: at,
        });
        if (!begun.created) {
          return failed(
            stamp(
              {
                code: "SETTLEMENT_IN_PROGRESS",
                outcome: "unknown",
                operation: "settle",
                message: "Another attempt for this settlement started at the same time.",
                remediation:
                  "Do not resend it. Call settle again in a moment: it will return the result of the other attempt.",
                retryable: true,
              },
              s,
            ),
          );
        }
        record = begun.record;
      }
    }
    const track = async (patch: Partial<LedgerRecord>) => {
      if (!ledger || !record) return;
      record = { ...record, ...patch, updatedAt: now().toISOString() };
      await ledger.save(record);
    };
    await track({ state: "in_progress" });

    // 6. Execute the missing steps, in order.
    const operations: OperationResult[] = [];
    for (const step of plan) {
      const done = applied[step.step];
      const known = record?.steps[step.step];
      if (done) {
        operations.push(fromMirror(done));
        continue;
      }
      if (known?.state === "confirmed" && known.transactionId) {
        operations.push(operationResult(step.step, known.transactionId, known.consensusTimestamp ?? ""));
        continue;
      }

      let transactionId: string | undefined;
      const memo = settlementMemo(s.eventKey, step.step);
      // Written BEFORE sending: if this process dies mid-send, a retry knows a transaction may be in flight.
      await track({
        steps: { ...record?.steps, [step.step]: { operation: step.step, state: "sent", sentAt: now().toISOString() } },
      });
      try {
        const send =
          step.step === "mint"
            ? executor.mint({
                tokenId: s.tokenId,
                amount: step.amount,
                memo,
                timeoutMs,
                onTransactionId: id => (transactionId = id),
              })
            : executor.transfer({
                tokenId: s.tokenId,
                from: step.from as string,
                to: beneficiary,
                amount: step.amount,
                memo,
                timeoutMs,
                onTransactionId: id => (transactionId = id),
              });
        const receipt = await withTimeout(send, timeoutMs);
        operations.push(operationResult(step.step, receipt.transactionId, receipt.consensusTimestamp));
        const confirmed: LedgerStep = {
          operation: step.step,
          state: "confirmed",
          transactionId: receipt.transactionId,
          consensusTimestamp: receipt.consensusTimestamp,
          sentAt: now().toISOString(),
        };
        await track({ steps: { ...record?.steps, [step.step]: confirmed } });
      } catch (error) {
        const failure = stamp(
          classifyHtsError(
            error,
            ctxOf(s, step.step, { transactionId, accountId: step.step === "transfer" ? beneficiary : undefined }),
          ),
          s,
        );
        const previousMint = operations.find(o => o.operation === "mint");
        const partial = step.step === "transfer" && failure.outcome === "rejected" && (previousMint || mintApplied);
        const result: HtsFailure = partial
          ? {
              ...failure,
              outcome: "partial",
              appliedTransactions: [previousMint?.transactionId, ...appliedTxIds()].filter(
                (id, i, all): id is string => Boolean(id) && all.indexOf(id) === i,
              ),
            }
          : failure;
        const stepState: LedgerStep = {
          operation: step.step,
          state: failure.outcome === "unknown" ? "unknown" : "rejected",
          ...(transactionId && { transactionId }),
          sentAt: now().toISOString(),
        };
        await track({
          state: failure.outcome === "unknown" ? "unknown" : "failed",
          steps: { ...record?.steps, [step.step]: stepState },
          failure: result,
        });
        return failed(result);
      }
    }

    const result = success(s, { status: "settled", source: "executed", operations, to: beneficiary, preflight: pre });
    await finish(record, s, result);
    return result;
  }

  async function finish(record: LedgerRecord | null, s: NormalizedSettlement, result: SettlementSuccess) {
    if (!ledger) return;
    const at = now().toISOString();
    const base: LedgerRecord = record ?? {
      idempotencyKey: s.eventKey,
      settlementId: s.settlementId,
      contentHash: s.contentHash,
      state: "completed",
      steps: {},
      createdAt: at,
      updatedAt: at,
    };
    await ledger.save({ ...base, state: "completed", result, failure: undefined, updatedAt: at });
  }

  const conflict = (s: NormalizedSettlement, where: string): HtsFailure =>
    stamp(
      {
        code: "CONFLICTING_SETTLEMENT",
        outcome: "not_sent",
        operation: "settle",
        message: `The settlement key ${s.eventKey} was already used by ${where} with different content (contentHash differs). Two different sets of facts cannot settle the same event.`,
        remediation:
          "Do not execute this settlement. It signals equivocation or a bug in the oracle adapter; investigate the two attestations (audit finding HCS_EQUIVOCATION).",
        retryable: false,
      },
      s,
    );

  function settle(input: unknown): Promise<SettleResult> {
    const parsed = validateSettlementInput(input);
    if (!parsed.ok) {
      return Promise.resolve(
        failed({
          code: "INVALID_SETTLEMENT",
          outcome: "not_sent",
          operation: "settle",
          message: `The settlement input is invalid: ${parsed.issues.map(i => `${i.field}: ${i.message}`).join(" ")}`,
          remediation: "Fix the listed fields. Nothing was sent.",
          retryable: false,
          issues: parsed.issues,
        }),
      );
    }
    // The same settlement running twice at once in this process is one execution.
    const key = `${parsed.value.eventKey}:${parsed.value.contentHash}`;
    const existing = inFlight.get(key);
    if (existing) return existing;
    const pending = run(parsed.value).finally(() => inFlight.delete(key));
    inFlight.set(key, pending);
    return pending;
  }

  return { config, preflight, checkSetup, associate, settle };
}

/** `0.0.9-1712345678-123456789` -> `0.0.9@1712345678.123456789` (Mirror format back to the SDK format). */
export function sdkTransactionId(mirrorId: string): string {
  const match = /^(\d+\.\d+\.\d+)-(\d+)-(\d+)$/.exec(mirrorId);
  return match ? `${match[1]}@${match[2]}.${match[3]}` : mirrorId;
}
