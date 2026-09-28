import { describe, expect, it } from "vitest";
import { id } from "ethers";
import {
  CREDENTIAL_ISSUED_TOPIC,
  CREDENTIAL_REVOKED_TOPIC,
  RegistryReadError,
  createCredentialStatusReader,
  decodeCredentialIssuedLog,
  decodeCredentialRevokedLog,
} from "./registry";
import {
  ADMIN,
  CREDENTIAL_ID,
  ISSUANCE_SEQUENCE,
  ISSUED_AT,
  ISSUER_SIGNER,
  NETWORK,
  REGISTRY,
  consistentWorld,
  fakeFetch,
  issuedLog,
  makeCredentialEvent,
  revokedLog,
} from "./test-fixtures";

describe("CredentialRegistry logs", () => {
  it("uses the contract's event signatures", () => {
    expect(CREDENTIAL_ISSUED_TOPIC).toBe(
      id("CredentialIssued(bytes32,bytes32,bytes32,bytes32,bytes32,bytes32,address,uint64,uint64,uint64)"),
    );
    expect(CREDENTIAL_REVOKED_TOPIC).toBe(id("CredentialRevoked(bytes32,bytes32,address,bool,uint64)"));
  });

  it("decodes CredentialIssued", () => {
    const event = makeCredentialEvent();
    const decoded = decodeCredentialIssuedLog(issuedLog(event));
    expect(decoded).toMatchObject({
      credentialId: CREDENTIAL_ID,
      issuer: event.issuer,
      credentialHash: event.credentialHash,
      signer: ISSUER_SIGNER.address.toLowerCase(),
      hcsSequence: ISSUANCE_SEQUENCE,
    });
  });

  it("decodes CredentialRevoked", () => {
    expect(decodeCredentialRevokedLog(revokedLog({ revokedBy: ADMIN.address, byAdmin: true }))).toMatchObject({
      credentialId: CREDENTIAL_ID,
      revokedBy: ADMIN.address.toLowerCase(),
      byAdmin: true,
    });
  });

  it("returns null for logs of another event or malformed data", () => {
    expect(decodeCredentialIssuedLog(revokedLog())).toBeNull();
    expect(decodeCredentialRevokedLog({ topics: [CREDENTIAL_REVOKED_TOPIC], data: "0x1234" })).toBeNull();
  });
});

describe("statusOf reader", () => {
  it("reads an issued record over eth_call", async () => {
    const world = await consistentWorld();
    const { fetch, calls } = fakeFetch(world);
    const reader = createCredentialStatusReader({ network: NETWORK, registryAddress: REGISTRY, fetch });
    const record = await reader.statusOf(CREDENTIAL_ID);
    expect(calls[0]).toMatch(/^POST /);
    expect(record).toMatchObject({ status: "issued", issuedAt: ISSUED_AT, revokedAt: 0n });
    expect(reader.origin).toBe("https://testnet.hashio.io");
  });

  it("reports an unseen credential as not_found", async () => {
    const reader = createCredentialStatusReader({
      network: NETWORK,
      registryAddress: REGISTRY,
      fetch: fakeFetch(await consistentWorld()).fetch,
    });
    expect((await reader.statusOf(id("never-issued"))).status).toBe("not_found");
  });

  it("throws RegistryReadError when the RPC is unreachable or the call reverts", async () => {
    const offline = createCredentialStatusReader({
      network: NETWORK,
      registryAddress: REGISTRY,
      fetch: fakeFetch({ ...(await consistentWorld()), offline: true }).fetch,
    });
    await expect(offline.statusOf(CREDENTIAL_ID)).rejects.toBeInstanceOf(RegistryReadError);

    const reverted = createCredentialStatusReader({
      network: NETWORK,
      registryAddress: REGISTRY,
      fetch: (async () => new Response(JSON.stringify({ error: { code: 3 } }))) as unknown as typeof fetch,
    });
    await expect(reverted.statusOf(CREDENTIAL_ID)).rejects.toBeInstanceOf(RegistryReadError);
  });
});
