import { execFile } from "node:child_process";
import { readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { withDeadline } from "./bounded";
import { IntegrationConfig } from "./config";
import { redactTestOutput } from "./redaction";

/**
 * Applying the production migration history to an empty database.
 *
 * The harness runs `prisma migrate deploy`, not `prisma db push`. The
 * difference is the whole point of the exercise: `db push` projects
 * `schema.prisma` onto the database and would let a migration that is broken,
 * missing, or ordered wrongly pass CI unnoticed. `migrate deploy` replays the
 * same SQL, in the same order, that a production release will — so a migration
 * that cannot apply from empty fails here rather than during a deployment.
 */

const REPO_ROOT = resolve(__dirname, "..", "..", "..");
const MIGRATIONS_DIR = join(REPO_ROOT, "prisma", "migrations");

/** The Prisma CLI entrypoint, resolved from the installed package. */
function prismaCliPath(): string {
  return require.resolve("prisma/build/index.js");
}

/** Directory names of the migrations that `migrate deploy` is expected to apply. */
export function migrationDirectoryNames(): string[] {
  return readdirSync(MIGRATIONS_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

interface CommandResult {
  stdout: string;
  stderr: string;
}

/**
 * Runs the Prisma CLI with `DATABASE_URL` pointed at `databaseUrl`.
 *
 * Spawned through `node <cli>` rather than `npx prisma`, because `npx`
 * resolution differs between platforms and can reach the network. Output is
 * redacted before it is surfaced: a failing `migrate deploy` prints the
 * datasource it was given, credentials included.
 */
function runPrisma(
  args: string[],
  databaseUrl: string,
  timeoutMs: number,
  label: string,
): Promise<CommandResult> {
  return withDeadline(
    label,
    timeoutMs,
    () =>
      new Promise<CommandResult>((resolvePromise, reject) => {
        execFile(
          process.execPath,
          [prismaCliPath(), ...args],
          {
            cwd: REPO_ROOT,
            env: {
              ...process.env,
              DATABASE_URL: databaseUrl,
              // Migration output is read by a machine here; the interactive
              // extras only make the redaction surface larger.
              PRISMA_HIDE_UPDATE_MESSAGE: "1",
              CHECKPOINT_DISABLE: "1",
            },
            // The CLI must not outlive the harness deadline that wraps it.
            timeout: timeoutMs,
            maxBuffer: 8 * 1024 * 1024,
          },
          (error, stdout, stderr) => {
            if (error) {
              reject(
                new Error(
                  `${label} failed: ${redactTestOutput(
                    [error.message, stdout, stderr].filter(Boolean).join("\n"),
                  )}`,
                ),
              );
              return;
            }
            resolvePromise({ stdout, stderr });
          },
        );
      }),
  );
}

/** Applies every migration in `prisma/migrations` to `databaseUrl`. */
export async function applyMigrations(
  databaseUrl: string,
  config: IntegrationConfig,
): Promise<void> {
  await runPrisma(
    ["migrate", "deploy"],
    databaseUrl,
    config.migrateTimeoutMs,
    "Applying production migrations to the template database",
  );
}

/**
 * Asserts the migrated database matches `schema.prisma` exactly.
 *
 * This is the check that catches the drift `migrate deploy` alone cannot: a
 * model edited in `schema.prisma` without a matching migration still generates
 * a working Prisma client, so every unit test passes while production is one
 * release away from a column that does not exist.
 *
 * `--exit-code` makes the CLI exit 2 when a difference is found.
 */
export async function assertNoSchemaDrift(
  databaseUrl: string,
  config: IntegrationConfig,
): Promise<void> {
  const schemaPath = join(REPO_ROOT, "prisma", "schema.prisma");

  await runPrisma(
    [
      "migrate",
      "diff",
      // `--from-schema-datasource` reads the URL from the datasource's env var
      // rather than taking it as an argument, keeping the connection string out
      // of the process list where no redaction can reach it.
      "--from-schema-datasource",
      schemaPath,
      "--to-schema-datamodel",
      schemaPath,
      "--exit-code",
    ],
    databaseUrl,
    config.migrateTimeoutMs,
    "Comparing the migrated database against prisma/schema.prisma",
  );
}
