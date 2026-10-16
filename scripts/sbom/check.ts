/**
 * CI gate for the dependency inventory: drift detection + license policy +
 * purpose-annotation coverage + doc-link validation.
 *
 * This is deliberately four checks in one script rather than four scripts,
 * because they all fail for the same underlying reason — someone changed a
 * dependency (or the docs describing them) without updating what is meant to
 * describe that dependency — and a contributor should see every consequence
 * of that in one run instead of three follow-up review cycles.
 *
 * Run: npm run sbom:check
 */
import { existsSync, readFileSync } from "fs";
import { join } from "path";
import {
  REPO_ROOT,
  buildInventory,
  licensesInLockfile,
  purposeFor,
  readPackageJson,
  renderInventoryMarkdown,
} from "./inventory-lib";

const INVENTORY_PATH = join(REPO_ROOT, "scripts", "sbom", "inventory.md");
const DEPENDENCIES_DOC = join(REPO_ROOT, "docs", "dependencies.md");

/**
 * Licenses known to be permissive/compatible with Apache-2.0 (this project's
 * license, see package.json + LICENSE) and already verified present in this
 * dependency tree as of the last audit. Anything not on this list — a new
 * license string never seen before — fails the check rather than passing
 * silently, even if it looks harmless, because "unreviewed" is the point
 * being enforced here.
 */
const ALLOWED_LICENSES = new Set([
  "MIT",
  "Apache-2.0",
  "ISC",
  "BSD-2-Clause",
  "BSD-3-Clause",
  "BlueOak-1.0.0",
  "0BSD",
  "Unlicense",
  "Python-2.0",
  "CC-BY-4.0",
  "(MIT AND BSD-3-Clause)",
  "(MIT OR CC0-1.0)",
]);

/**
 * Copyleft / network-copyleft licenses incompatible with distributing this
 * Apache-2.0 backend. Listed explicitly (rather than relying on "not in the
 * allow list") so a failure names the specific legal concern instead of
 * making the contributor guess whether it was a typo or a real problem.
 */
const DENIED_LICENSES = new Set([
  "GPL-1.0",
  "GPL-2.0",
  "GPL-3.0",
  "AGPL-1.0",
  "AGPL-3.0",
  "LGPL-2.0",
  "LGPL-2.1",
  "LGPL-3.0",
  "SSPL-1.0",
  "CC-BY-SA-4.0",
  "CC-BY-NC-4.0",
]);

/**
 * Packages already confirmed (manually, at the time this check was written)
 * to carry a permissive license despite their own package.json omitting an
 * SPDX `license` field, so the lockfile entry has none either. Recorded by
 * exact name + version so an unrelated future package landing with the same
 * "no license field" gap still fails loudly instead of being silently waved
 * through by this list.
 */
const KNOWN_UNLISTED_LICENSES: Record<string, string> = {
  "@apidevtools/json-schema-ref-parser@14.0.1": "MIT",
  "@apidevtools/openapi-schemas@2.1.0": "MIT",
  "@apidevtools/swagger-methods@3.0.2": "MIT",
  "@apidevtools/swagger-parser@12.1.0": "MIT",
  "@nestjs/throttler@6.5.0": "MIT",
  "ajv-draft-04@1.0.0": "MIT",
  "busboy@1.6.0": "MIT",
  "call-me-maybe@1.0.2": "MIT",
  "openapi-types@12.1.3": "MIT",
  "streamsearch@1.1.0": "MIT",
};

let failed = false;

function fail(message: string): void {
  console.error(`FAIL: ${message}`);
  failed = true;
}

function ok(message: string): void {
  console.log(`ok: ${message}`);
}

/** 1. Drift detection — regenerate and diff against the committed file. */
function checkDrift(): void {
  if (!existsSync(INVENTORY_PATH)) {
    fail("scripts/sbom/inventory.md does not exist. Run `npm run sbom:generate`.");
    return;
  }

  const committed = readFileSync(INVENTORY_PATH, "utf8");
  const regenerated = renderInventoryMarkdown(buildInventory());

  if (committed !== regenerated) {
    fail(
      "scripts/sbom/inventory.md is out of date with package.json / package-lock.json. " +
        "Run `npm run sbom:generate` and commit the result.",
    );
    return;
  }

  ok("scripts/sbom/inventory.md matches the current lockfile (no drift)");
}

/** 2. License policy across the full lockfile (direct + transitive). */
function checkLicenses(): void {
  const lock = readFileSync(join(REPO_ROOT, "package-lock.json"), "utf8");
  const parsedLock = JSON.parse(lock) as {
    packages: Record<string, { version?: string }>;
  };
  const licenses = licensesInLockfile();

  const denied: string[] = [];
  const unknown: string[] = [];

  for (const [name, license] of licenses) {
    if (DENIED_LICENSES.has(license)) {
      denied.push(`${name} (${license})`);
      continue;
    }

    if (ALLOWED_LICENSES.has(license)) {
      continue;
    }

    // license === "UNKNOWN" means the lockfile entry had no license field.
    // Check the known-unlisted exceptions before flagging it as new/unknown.
    const version =
      parsedLock.packages[`node_modules/${name}`]?.version ?? "unknown-version";
    const exceptionKey = `${name}@${version}`;
    if (license === "UNKNOWN" && KNOWN_UNLISTED_LICENSES[exceptionKey]) {
      continue;
    }

    unknown.push(`${name}@${version} (${license})`);
  }

  if (denied.length > 0) {
    fail(`prohibited license(s) found: ${denied.join(", ")}`);
  } else {
    ok("no prohibited (copyleft/incompatible) licenses found");
  }

  if (unknown.length > 0) {
    fail(
      `unrecognized or missing license(s) — add to ALLOWED_LICENSES, ` +
        `KNOWN_UNLISTED_LICENSES, or investigate: ${unknown.join(", ")}`,
    );
  } else {
    ok("every dependency license is recognized (allow-listed or a verified exception)");
  }
}

/** 3. Every direct dependency has a purpose annotation, and vice versa. */
function checkPurposeCoverage(): void {
  const pkg = readPackageJson();
  const direct = [
    ...Object.keys(pkg.dependencies ?? {}),
    ...Object.keys(pkg.devDependencies ?? {}),
  ];

  const missing = direct.filter((name) => purposeFor(name).paths.length === 0);

  if (missing.length > 0) {
    fail(
      `direct dependencies with no purpose annotation in scripts/sbom/inventory-lib.ts: ${missing.join(", ")}`,
    );
  } else {
    ok("every direct dependency has a purpose annotation");
  }
}

/** 4. Local file paths referenced by docs/dependencies.md actually exist. */
function checkDocLinks(): void {
  if (!existsSync(DEPENDENCIES_DOC)) {
    fail("docs/dependencies.md does not exist.");
    return;
  }

  const content = readFileSync(DEPENDENCIES_DOC, "utf8");
  const broken: string[] = [];

  for (const match of content.matchAll(/\]\(([^)]+)\)/g)) {
    const raw = match[1].trim();
    if (raw.startsWith("http://") || raw.startsWith("https://")) continue;
    if (raw.startsWith("#")) continue;
    if (raw.startsWith("mailto:")) continue;

    const target = raw.split("#")[0];
    if (target.length === 0) continue;

    const resolved = join(REPO_ROOT, "docs", target);
    if (!existsSync(resolved)) {
      broken.push(raw);
    }
  }

  if (broken.length > 0) {
    fail(`docs/dependencies.md references path(s) that do not exist: ${broken.join(", ")}`);
  } else {
    ok("every local path referenced by docs/dependencies.md exists");
  }
}

function main(): void {
  checkDrift();
  checkLicenses();
  checkPurposeCoverage();
  checkDocLinks();

  if (failed) {
    console.error("\nsbom:check failed.");
    process.exit(1);
  }

  console.log("\nsbom:check passed.");
}

main();
