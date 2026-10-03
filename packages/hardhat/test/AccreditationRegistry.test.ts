import { readFile } from "node:fs/promises";
import { expect } from "chai";
import { ethers, artifacts } from "hardhat";
import { time } from "@nomicfoundation/hardhat-network-helpers";
import { GENERATED_ARTIFACT, renderArtifact } from "../hardhat.config";

const COURSE = "Solidity Basics";
const DEFINITION = "did:hedera:testnet:z6Mk_0.0.10/anoncreds/v1/PUBLIC_CRED_DEF/0.0.12";
const OTHER = "did:hedera:testnet:z6Mk_0.0.10/anoncreds/v1/PUBLIC_CRED_DEF/0.0.99";

async function deploy() {
  const [authority, stranger] = await ethers.getSigners();
  const registry: any = await (await ethers.getContractFactory("AccreditationRegistry")).deploy();
  return { registry, authority, stranger };
}

describe("AccreditationRegistry", () => {
  it("records the deployer as the authority", async () => {
    const { registry, authority } = await deploy();
    expect(await registry.authority()).to.equal(authority.address);
  });

  it("accredits a credential definition for a course from the block time on", async () => {
    const { registry } = await deploy();
    const before = await time.latest();
    await expect(registry.accredit(COURSE, DEFINITION)).to.emit(registry, "Accredited");
    const grantedAt = await time.latest();
    expect(await registry.credentialDefinitions(COURSE)).to.deep.equal([DEFINITION]);
    expect(await registry.isAccredited(COURSE, DEFINITION, grantedAt)).to.equal(true);
    expect(await registry.isAccredited(COURSE, DEFINITION, before)).to.equal(false);
    expect(await registry.isAccredited("Advanced Solidity", DEFINITION, grantedAt)).to.equal(false);
    expect(await registry.isAccredited(COURSE, OTHER, grantedAt)).to.equal(false);
  });

  it("keeps history exact after a withdrawal, and never re-accredits a withdrawn definition", async () => {
    const { registry } = await deploy();
    await registry.accredit(COURSE, DEFINITION);
    const grantedAt = await time.latest();
    await time.increase(100);
    await expect(registry.withdraw(COURSE, DEFINITION)).to.emit(registry, "Withdrawn");
    const withdrawnAt = await time.latest();

    expect(await registry.isAccredited(COURSE, DEFINITION, grantedAt + 50)).to.equal(true);
    expect(await registry.isAccredited(COURSE, DEFINITION, withdrawnAt)).to.equal(false);
    expect(await registry.credentialDefinitions(COURSE)).to.deep.equal([DEFINITION]);
    await expect(registry.accredit(COURSE, DEFINITION)).to.be.revertedWithCustomError(registry, "AlreadyAccredited");
    await expect(registry.withdraw(COURSE, DEFINITION)).to.be.revertedWithCustomError(registry, "NotAccredited");
  });

  it("lists every definition ever accredited for a course, in order", async () => {
    const { registry } = await deploy();
    await registry.accredit(COURSE, DEFINITION);
    await registry.accredit(COURSE, OTHER);
    await registry.withdraw(COURSE, DEFINITION);
    expect(await registry.credentialDefinitions(COURSE)).to.deep.equal([DEFINITION, OTHER]);
    expect(await registry.credentialDefinitions("Unknown")).to.deep.equal([]);
  });

  it("rejects everyone but the authority, empty values and unknown withdrawals", async () => {
    const { registry, stranger } = await deploy();
    await expect(registry.connect(stranger).accredit(COURSE, DEFINITION)).to.be.revertedWithCustomError(
      registry,
      "NotAuthority",
    );
    await registry.accredit(COURSE, DEFINITION);
    await expect(registry.connect(stranger).withdraw(COURSE, DEFINITION)).to.be.revertedWithCustomError(
      registry,
      "NotAuthority",
    );
    await expect(registry.accredit("", DEFINITION)).to.be.revertedWithCustomError(registry, "EmptyValue");
    await expect(registry.accredit(COURSE, "")).to.be.revertedWithCustomError(registry, "EmptyValue");
    await expect(registry.withdraw(COURSE, OTHER)).to.be.revertedWithCustomError(registry, "NotAccredited");
  });

  it("matches the ABI and bytecode the SDK deploys (run `yarn codegen` after changing the contract)", async () => {
    const artifact = await artifacts.readArtifact("AccreditationRegistry");
    const committed = (await readFile(GENERATED_ARTIFACT, "utf8")).replace(/\r\n/g, "\n");
    expect(committed).to.equal(renderArtifact(artifact.abi, artifact.bytecode));
  });
});
