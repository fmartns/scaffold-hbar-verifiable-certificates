import * as dotenv from "dotenv";
import path from "node:path";
import { HardhatUserConfig } from "hardhat/config";
import "@nomicfoundation/hardhat-ethers";
import "@nomicfoundation/hardhat-chai-matchers";
import "@nomicfoundation/hardhat-verify";
import "@typechain/hardhat";
import "hardhat-deploy";
import "hardhat-deploy-ethers";
import { getNetwork } from "@sh/sdk";

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

const config: HardhatUserConfig = {
  solidity: {
    compilers: [
      {
        version: "0.8.28",
        settings: {
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
    hederaLocal: { url: local.rpcUrl, chainId: local.chainId, accounts },
    hederaTestnet: { url: testnet.rpcUrl, chainId: testnet.chainId, accounts },
    hederaMainnet: { url: mainnet.rpcUrl, chainId: mainnet.chainId, accounts },
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
