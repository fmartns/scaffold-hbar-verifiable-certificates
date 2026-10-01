import * as dotenv from "dotenv";
import path from "node:path";
import { HardhatUserConfig, task } from "hardhat/config";
import "@nomicfoundation/hardhat-ethers";
import "@nomicfoundation/hardhat-chai-matchers";
import "@nomicfoundation/hardhat-verify";
import "@typechain/hardhat";
import "hardhat-deploy";
import "hardhat-deploy-ethers";
import { HARDHAT_NETWORK_NAMES, getNetwork } from "@sh/sdk";
import { runCodegen } from "./scripts/generateTsAbis";

// A single .env at the repository root feeds every workspace.
dotenv.config({ path: path.resolve(__dirname, "../../.env") });

const env = process.env;
const testnet = getNetwork("testnet", env);
const mainnet = getNetwork("mainnet", env);
const local = getNetwork("local", env);

// The deployer key is injected at runtime by the deploy wrapper after decrypting the keystore. There is deliberately
// no default key: without it, live networks have no accounts and a deploy fails instead of using a well-known key.
const deployerKey = env.__RUNTIME_DEPLOYER_PRIVATE_KEY;
const accounts = deployerKey ? [deployerKey] : [];

// Every deploy ends by regenerating packages/sdk/generated (ABIs + this network's deployments): nobody copies an
// address or an ABI by hand. Test fixtures do not go through this task, so tests never write the manifest.
task("deploy").setAction(async (args, hre, runSuper) => {
  const result = await runSuper(args);
  await runCodegen(hre);
  return result;
});

task("codegen", "Regenerates packages/sdk/generated from the compiled artifacts and this network's deployments")
  .addFlag("check", "Fail if the committed output is stale instead of writing it (no network access)")
  .setAction(async ({ check }: { check: boolean }, hre) => {
    await hre.run("compile", { quiet: true });
    await runCodegen(hre, { check });
  });

const config: HardhatUserConfig = {
  solidity: {
    compilers: [
      {
        version: "0.8.28",
        settings: {
          // OpenZeppelin 5.x uses `mcopy`; Hedera's EVM supports Cancun.
          evmVersion: "cancun",
          optimizer: {
            enabled: true,
            runs: 200,
          },
        },
      },
    ],
  },
  defaultNetwork: "hardhat",
  namedAccounts: {
    deployer: {
      default: 0,
    },
  },
  networks: {
    hardhat: {},
    [HARDHAT_NETWORK_NAMES.local]: { url: local.rpcUrl, chainId: local.chainId, accounts },
    [HARDHAT_NETWORK_NAMES.testnet]: { url: testnet.rpcUrl, chainId: testnet.chainId, accounts },
    [HARDHAT_NETWORK_NAMES.mainnet]: { url: mainnet.rpcUrl, chainId: mainnet.chainId, accounts },
  },
  // Hedera contracts are verified on Sourcify; there is no Etherscan API.
  sourcify: {
    enabled: true,
  },
  etherscan: {
    enabled: false,
    apiKey: {},
  },
  typechain: {
    outDir: "typechain-types",
    target: "ethers-v6",
  },
};

export default config;
