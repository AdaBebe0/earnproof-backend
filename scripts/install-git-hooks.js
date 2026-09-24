const { spawnSync } = require("node:child_process");

const repositoryCheck = spawnSync(
  "git",
  ["rev-parse", "--is-inside-work-tree"],
  { stdio: "ignore" },
);

if (repositoryCheck.status !== 0) {
  console.log("Git metadata not found; skipping local hook setup.");
  process.exit(0);
}

const setup = spawnSync(
  "git",
  ["config", "core.hooksPath", ".githooks"],
  { stdio: "inherit" },
);

if (setup.error) {
  console.error(`Unable to configure Git hooks: ${setup.error.message}`);
  process.exit(1);
}

process.exit(setup.status ?? 1);
