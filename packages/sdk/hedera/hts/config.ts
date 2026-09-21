/**
 * Configuration of the HTS adapter, read from the environment. Nothing is hardcoded. The operator private key is not part
 * of it: only the executor ever sees it.
 */
import { getAddress } from "ethers";
import { ENV as HEDERA_ENV } from "../environment";
import type { EnvironmentVariables } from "../environment";
import { getSelectedNetwork, isNetworkName } from "../networks";
import type { HederaNetwork } from "../networks";
import { HCS_ENV } from "../hcs/config";
import { HtsError } from "./errors";
import { isEntityId } from "./settlement";
import type { SettlementModel } from "./settlement";

export const HTS_ENV = {
  TOKEN_ID: "HEDERA_HTS_TOKEN_ID",
  MODEL: "HEDERA_HTS_SETTLEMENT_MODEL",
  CUSTODY: "HEDERA_HTS_CUSTODY",
  TREASURY_ID: "HEDERA_HTS_TREASURY_ID",
} as const;

/**
 * Who holds the token's treasury and keys.
 * - `router` (ADR v1, production): the SettlementRouter contract mints and transfers on-chain. No off-chain process can
 *   mint (ADR D12); this adapter then only preflights, associates and interprets results.
 * - `operator` (dev/test only): the operator account is treasury and supply key, so this adapter can execute the
 *   operations itself. It contradicts the production trust model and is refused on mainnet.
 */
export type Custody = "router" | "operator";

export interface HtsAdapterConfig {
  network: HederaNetwork;
  tokenId: string;
  model: SettlementModel;
  custody: Custody;
  /** Router EVM address (lowercase). Required for `router` custody. */
  routerAddress?: string;
  /** Treasury account for `operator` custody; defaults to the operator. */
  treasuryId?: string;
  /** Operator account id, for `operator` custody. */
  operatorId?: string;
}

export function loadHtsAdapterConfig(env: EnvironmentVariables): HtsAdapterConfig {
  const problems: { variable: string; message: string; remediation: string }[] = [];
  const problem = (variable: string, message: string, remediation: string) =>
    problems.push({ variable, message, remediation });

  const rawNetwork = env[HEDERA_ENV.NETWORK]?.trim();
  if (rawNetwork && !isNetworkName(rawNetwork)) {
    problem(
      HEDERA_ENV.NETWORK,
      `${HEDERA_ENV.NETWORK} "${rawNetwork}" is not a supported network.`,
      "Use testnet, mainnet or local.",
    );
  }

  const tokenId = env[HTS_ENV.TOKEN_ID]?.trim() ?? "";
  if (!tokenId) {
    problem(
      HTS_ENV.TOKEN_ID,
      `${HTS_ENV.TOKEN_ID} is not set.`,
      `Set ${HTS_ENV.TOKEN_ID}=0.0.<token>: the HTS token that represents the settled asset.`,
    );
  } else if (!isEntityId(tokenId)) {
    problem(
      HTS_ENV.TOKEN_ID,
      `${HTS_ENV.TOKEN_ID} is not a valid token id (expected 0.0.x).`,
      "Copy the token id from HashScan.",
    );
  }

  const rawModel = env[HTS_ENV.MODEL]?.trim() || "mint-transfer";
  const model = rawModel as SettlementModel;
  if (rawModel !== "mint-transfer" && rawModel !== "pool-transfer") {
    problem(
      HTS_ENV.MODEL,
      `${HTS_ENV.MODEL} "${rawModel}" is not a settlement model.`,
      "Use mint-transfer (ADR v1) or pool-transfer.",
    );
  }

  const rawCustody = env[HTS_ENV.CUSTODY]?.trim() || "router";
  const custody = rawCustody as Custody;
  if (rawCustody !== "router" && rawCustody !== "operator") {
    problem(
      HTS_ENV.CUSTODY,
      `${HTS_ENV.CUSTODY} "${rawCustody}" is not a custody mode.`,
      "Use router (production, ADR v1) or operator (dev/test only).",
    );
  }

  const network = rawNetwork && !isNetworkName(rawNetwork) ? undefined : getSelectedNetwork(env);
  // The router address is required for router custody, and used whenever it is set: the router's `statusOf` is the
  // authority on whether an event was settled, whoever executes the operations.
  let routerAddress: string | undefined;
  const router = env[HCS_ENV.ROUTER_ADDRESS]?.trim();
  if (router) {
    try {
      routerAddress = getAddress(router).toLowerCase();
      if (/^0x0{40}$/.test(routerAddress)) throw new Error("zero");
    } catch {
      routerAddress = undefined;
      problem(
        HCS_ENV.ROUTER_ADDRESS,
        `${HCS_ENV.ROUTER_ADDRESS} is not a valid, non-zero EVM address.`,
        "Use the 0x… address of the deployed SettlementRouter.",
      );
    }
  } else if (custody === "router") {
    problem(
      HCS_ENV.ROUTER_ADDRESS,
      `${HCS_ENV.ROUTER_ADDRESS} is not set, and router custody needs it.`,
      "Set the deployed SettlementRouter EVM address: the router is the token's treasury and supply-key holder.",
    );
  }

  let operatorId: string | undefined;
  let treasuryId: string | undefined;
  if (custody === "operator") {
    if (network?.name === "mainnet") {
      problem(
        HTS_ENV.CUSTODY,
        "Operator custody lets an off-chain key mint and move the settlement token, which the trust model forbids in production (ADR D12).",
        "Use router custody on mainnet. Operator custody is for development and Testnet only.",
      );
    }
    operatorId = env[HEDERA_ENV.OPERATOR_ID]?.trim();
    if (!operatorId || !isEntityId(operatorId)) {
      problem(
        HEDERA_ENV.OPERATOR_ID,
        `${HEDERA_ENV.OPERATOR_ID} is missing or not a valid account id, and operator custody needs it.`,
        "Set HEDERA_OPERATOR_ID=0.0.<your account>. Run `yarn setup` to diagnose.",
      );
    }
    const configuredTreasury = env[HTS_ENV.TREASURY_ID]?.trim();
    if (configuredTreasury && !isEntityId(configuredTreasury)) {
      problem(
        HTS_ENV.TREASURY_ID,
        `${HTS_ENV.TREASURY_ID} is not a valid account id.`,
        "Use 0.0.x, or leave it empty to use the operator.",
      );
    }
    treasuryId = configuredTreasury || operatorId;
  }

  if (problems.length > 0 || !network) {
    throw new HtsError({
      code: "CONFIG_INVALID",
      outcome: "not_sent",
      operation: "preflight",
      message: `Invalid HTS adapter configuration: ${problems.map(p => p.message).join(" ")}`,
      remediation: problems.map(p => `${p.variable}: ${p.remediation}`).join(" "),
      retryable: false,
      configIssues: problems,
    });
  }

  return { network, tokenId, model, custody, routerAddress, treasuryId, operatorId };
}
