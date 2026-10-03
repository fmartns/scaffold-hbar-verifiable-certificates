const path = require("path");

const eslintCommand = (pkg, script) => filenames =>
  `yarn ${script} --fix ${filenames.map(f => path.relative(path.join("packages", pkg), f)).join(" ")}`;

module.exports = {
  "packages/nextjs/**/*.{ts,tsx}": [eslintCommand("nextjs", "next:lint-staged"), () => "yarn next:check-types"],
  "packages/sdk/**/*.ts": [eslintCommand("sdk", "sdk:lint-staged"), () => "yarn sdk:check-types"],
};
