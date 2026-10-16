import { PrismaClient } from "@prisma/client";

/**
 * Reference-data seed.
 *
 * Every environment legitimately needs the supported-asset rows, including
 * production, so this file is deliberately free of fabricated records and
 * carries no environment guard. Synthetic users, payments and proofs live in
 * `prisma/seed-demo.ts`, which refuses to run anywhere but a local or
 * disposable database.
 *
 * Written as an upsert so re-running converges on the same state rather than
 * failing on a unique constraint.
 */
async function main(): Promise<void> {
  if (!process.env.DATABASE_URL) {
    // Prisma would otherwise fail later with a message about a missing
    // datasource, which reads as a build problem rather than a missing variable.
    throw new Error("DATABASE_URL is not set; nothing to seed.");
  }

  const prisma = new PrismaClient();

  try {
    await prisma.supportedAsset.upsert({
      where: {
        assetKey: "stellar-testnet:XLM:native",
      },
      update: {},
      create: {
        assetKey: "stellar-testnet:XLM:native",
        code: "XLM",
        issuer: null,
        network: "stellar-testnet",
      },
    });
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
