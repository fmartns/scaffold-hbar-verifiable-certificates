/**
 * Browser-safe part of the credential module: issuer form presets and drafts (over `./schema`), EIP-712 payloads, registry calldata, error taxonomy
 * and the issuer flow. Nothing here imports the Hedera SDK, Node built-ins or the environment. Client components reach
 * it through `@sh/sdk/hedera/wallet`.
 */
export * from "./fields";
export type { CredentialDocument } from "./schema";
export * from "./signing";
export * from "./registry-calls";
export * from "./errors";
export * from "./issuer-flow";
