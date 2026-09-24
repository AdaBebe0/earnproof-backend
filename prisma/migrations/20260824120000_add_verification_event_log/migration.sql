-- CreateEnum for VerificationOutcome
CREATE TYPE "VerificationOutcome" AS ENUM ('VALID', 'EXPIRED', 'REVOKED', 'UNKNOWN', 'INVALID_SIGNATURE', 'ISSUER_WARNING');

-- CreateTable VerificationEventLog
CREATE TABLE "VerificationEventLog" (
    "id" TEXT NOT NULL,
    "outcome" "VerificationOutcome" NOT NULL,
    "proofId" TEXT NOT NULL,
    "metadataHash" TEXT NOT NULL,
    "saltVersion" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "retainUntil" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "VerificationEventLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "VerificationEventLog_proofId_createdAt_idx" ON "VerificationEventLog"("proofId", "createdAt");

-- CreateIndex
CREATE INDEX "VerificationEventLog_outcome_idx" ON "VerificationEventLog"("outcome");

-- CreateIndex
CREATE INDEX "VerificationEventLog_retainUntil_idx" ON "VerificationEventLog"("retainUntil");
