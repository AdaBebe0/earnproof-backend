import { existsSync, readdirSync, readFileSync, statSync } from "fs";
import { join, resolve } from "path";

/**
 * The API key guide, checked against the code it describes.
 *
 * An integrator guide is read once, at the moment someone is deciding how to
 * authenticate, and believed. A scope that exists but is undocumented is a
 * permission nobody grants; a header the guide names but the guard does not read
 * is an afternoon lost. Both failures are silent in review and expensive in
 * support, so they are checked here instead.
 */

const REPO_ROOT = resolve(__dirname, "..");
const GUIDE_PATH = join(REPO_ROOT, "docs", "api-keys-guide.md");

function sourceFiles(dir: string): string[] {
  const found: string[] = [];

  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      found.push(...sourceFiles(full));
    } else if (entry.endsWith(".ts") && !entry.endsWith(".spec.ts")) {
      found.push(full);
    }
  }

  return found;
}

describe("API key integration guide", () => {
  const guide = existsSync(GUIDE_PATH) ? readFileSync(GUIDE_PATH, "utf8") : "";

  it("exists and is linked from the README", () => {
    expect(existsSync(GUIDE_PATH)).toBe(true);

    const readme = readFileSync(join(REPO_ROOT, "README.md"), "utf8");
    expect(readme).toContain("docs/api-keys-guide.md");
  });

  it("documents every scope the schema defines", () => {
    // A scope that exists but is absent from the guide is a permission an
    // integrator will never think to ask for.
    const schema = readFileSync(
      join(REPO_ROOT, "prisma", "schema.prisma"),
      "utf8",
    );
    const enumBlock = /enum ApiKeyScope \{([^}]*)\}/.exec(schema);
    expect(enumBlock).not.toBeNull();

    const scopes = (enumBlock as RegExpExecArray)[1]
      .split("\n")
      .map((line) => line.replace(/\/\/.*/, "").trim())
      .filter((line) => /^[A-Z_]+$/.test(line));

    expect(scopes.length).toBeGreaterThan(0);
    expect(scopes.filter((scope) => !guide.includes(scope))).toEqual([]);
  });

  it("names the headers the guard actually reads", () => {
    // The single most common integration mistake is presenting the key the way
    // some other API expects it. The guide says which headers are read; this
    // fails if the guard ever stops reading them.
    const guard = readFileSync(
      join(REPO_ROOT, "src", "common", "guards", "api-key.guard.ts"),
      "utf8",
    );

    expect(guard).toContain("x-organization-id");
    expect(guard).toContain("Bearer ");

    expect(guide).toContain("X-Organization-Id");
    expect(guide).toContain("Authorization: Bearer");
    // The guide states this explicitly, because the absence of an X-API-Key
    // header is exactly the kind of thing a reader assumes rather than checks.
    expect(guide).toContain("X-API-Key");
  });

  it("documents every scope-gated route", () => {
    // Each route that demands a scope is named in the guide, alongside the
    // scope it demands, so the scope table answers "what is this for?".
    const gated: { scope: string; route: string }[] = [];

    for (const file of sourceFiles(join(REPO_ROOT, "src"))) {
      const content = readFileSync(file, "utf8");
      const scopes = [
        ...content.matchAll(/@RequireScopes\(ApiKeyScope\.([A-Z_]+)\)/g),
      ].map((match) => match[1]);

      if (scopes.length === 0) continue;

      const controller = /@Controller\("([^"]*)"\)/.exec(content);
      if (!controller) continue;

      for (const scope of scopes) {
        gated.push({ scope, route: `/api/v1/${controller[1]}` });
      }
    }

    expect(gated.length).toBeGreaterThan(0);

    const undocumented = gated.filter(
      ({ scope, route }) => !guide.includes(scope) || !guide.includes(route),
    );

    expect(undocumented).toEqual([]);
  });

  it("warns about the one-time secret and the immediate rotation cutover", () => {
    // Two properties an integrator cannot discover from a schema, and only
    // learns from the incident: the secret is never shown again, and rotation
    // has no overlap window.
    expect(guide).toMatch(/shown once|only copy|never retrievable/i);
    expect(guide).toMatch(/immediately/i);
  });
});
