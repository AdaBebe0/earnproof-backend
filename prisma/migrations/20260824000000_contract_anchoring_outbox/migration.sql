-- CreateEnum
CREATE TYPE "AnchoringOperation" AS ENUM ('REGISTER', 'REVOKE');

-- CreateEnum
CREATE TYPE "AnchoringStatus" AS ENUM ('PENDING', 'PROCESSING', 'CONFIRMED', 'FAILED');

-- CreateTable
CREATE TABLE "AnchoringIntent" (
    "id" TEXT NOT NULL,
    "proofId" TEXT NOT NULL,
    "operation" "AnchoringOperation" NOT NULL,
    "status" "AnchoringStatus" NOT NULL DEFAULT 'PENDING',
    "attemptCount" INTEGER NOT NULL DEFAULT 0,
    "lastAttemptAt" TIMESTAMP(3),
    "nextRetryAt" TIMESTAMP(3),
    "transactionHash" TEXT,
    "ledger" TEXT,
    "lastErrorSafe" TEXT,
    "permanentError" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AnchoringIntent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AnchoringIntent_status_nextRetryAt_idx" ON "AnchoringIntent"("status", "nextRetryAt");

-- CreateIndex
CREATE INDEX "AnchoringIntent_proofId_operation_idx" ON "AnchoringIntent"("proofId", "operation");

-- AddForeignKey
ALTER TABLE "AnchoringIntent" ADD CONSTRAINT "AnchoringIntent_proofId_fkey" FOREIGN KEY ("proofId") REFERENCES "Proof"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
