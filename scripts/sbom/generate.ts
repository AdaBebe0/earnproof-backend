/**
 * Generates the reviewable dependency inventory at scripts/sbom/inventory.md.
 *
 * Reproducibility: this reads only package.json and package-lock.json — no
 * `npm install` and no `node_modules` walk. Running it twice against the same
 * lockfile produces byte-identical output, which is what lets `sbom:check`
 * detect drift by simple diff rather than a fuzzy comparison.
 *
 * Run: npm run sbom:generate
 */
import { writeFileSync } from "fs";
import { join } from "path";
import { REPO_ROOT, buildInventory, renderInventoryMarkdown } from "./inventory-lib";

function main(): void {
  const inventory = buildInventory();
  const markdown = renderInventoryMarkdown(inventory);
  const outPath = join(REPO_ROOT, "scripts", "sbom", "inventory.md");

  writeFileSync(outPath, markdown, "utf8");

  console.log(
    `ok: wrote ${inventory.runtime.length} runtime + ${inventory.build.length} build ` +
      `dependencies to scripts/sbom/inventory.md`,
  );
}

main();
