import { HardhatRuntimeEnvironment } from "hardhat/types";
import { DeployFunction } from "hardhat-deploy/types";
import { HCS_ENV, isValidTopicId } from "@sh/sdk";

/**
 * Deploys `CredentialRegistry` with the deployer as admin. The HCS evidence topic number is immutable per deployment:
 * live networks require `HEDERA_HCS_TOPIC_ID` (create it with `yarn hcs:topic`); the in-process network uses 0.
 */
const deployCredentialRegistry: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  const { deployer } = await hre.getNamedAccounts();
  const topicId = process.env[HCS_ENV.TOPIC_ID]?.trim() ?? "";
  const isLive = hre.network.live;

  let hcsTopicNum = 0n;
  if (topicId) {
    if (!isValidTopicId(topicId)) {
      throw new Error(`${HCS_ENV.TOPIC_ID} is not a valid topic id (expected shard.realm.num, e.g. 0.0.1234).`);
    }
    hcsTopicNum = BigInt(topicId.split(".")[2]);
  } else if (isLive) {
    throw new Error(`${HCS_ENV.TOPIC_ID} is required to deploy CredentialRegistry on ${hre.network.name}.`);
  }

  await hre.deployments.deploy("CredentialRegistry", {
    from: deployer,
    args: [deployer, hcsTopicNum],
    log: true,
    autoMine: true,
  });
};

export default deployCredentialRegistry;
deployCredentialRegistry.tags = ["CredentialRegistry"];
