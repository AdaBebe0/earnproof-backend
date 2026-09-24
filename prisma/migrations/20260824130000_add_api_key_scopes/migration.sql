-- CreateEnum for ApiKeyScope
CREATE TYPE "ApiKeyScope" AS ENUM ('PROOF_READ', 'PROOF_VERIFY', 'PAYMENT_READ', 'PAYMENT_WRITE', 'ORG_READ', 'ORG_ADMIN');

-- AlterTable ApiKey to add new fields
-- "lastUsedAt" is deliberately absent: it is created by the baseline migration
-- 20260713210000_phase1_persistence. Re-adding it here made this migration fail
-- with 42701 on any database built from the migration history, so a fresh
-- environment could never be provisioned.
ALTER TABLE "ApiKey" ADD COLUMN "prefix" VARCHAR(8) NOT NULL DEFAULT '',
ADD COLUMN "rotatedAt" TIMESTAMP(3),
ADD COLUMN "revokedAt" TIMESTAMP(3);

-- The default exists only to backfill rows that predate the column. Keeping it
-- would leave the database disagreeing with schema.prisma, which declares
-- `prefix` with no default, and would silently store an empty prefix for any
-- insert that forgot to supply one.
ALTER TABLE "ApiKey" ALTER COLUMN "prefix" DROP DEFAULT;

-- CreateTable ApiKeyScopeAssignment
CREATE TABLE "ApiKeyScopeAssignment" (
    "id" TEXT NOT NULL,
    "apiKeyId" TEXT NOT NULL,
    "scope" "ApiKeyScope" NOT NULL,

    CONSTRAINT "ApiKeyScopeAssignment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ApiKeyScopeAssignment_apiKeyId_scope_key" ON "ApiKeyScopeAssignment"("apiKeyId", "scope");

-- No separate index on ApiKeyScopeAssignment("apiKeyId"): the unique index on
-- ("apiKeyId", "scope") above already serves apiKeyId lookups as its leftmost
-- prefix. schema.prisma declares only the unique constraint, so a second index
-- here would be both redundant and a permanent disagreement with the model.

-- CreateIndex
CREATE INDEX "ApiKey_prefix_idx" ON "ApiKey"("prefix");

-- AddForeignKey
ALTER TABLE "ApiKeyScopeAssignment" ADD CONSTRAINT "ApiKeyScopeAssignment_apiKeyId_fkey" FOREIGN KEY ("apiKeyId") REFERENCES "ApiKey"("id") ON DELETE CASCADE ON UPDATE CASCADE;
