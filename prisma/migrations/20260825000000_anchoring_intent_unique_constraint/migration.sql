-- Drop the old non-unique indexes that allowed concurrent claims
DROP INDEX "AnchoringIntent_status_nextRetryAt_idx";
DROP INDEX "AnchoringIntent_proofId_operation_idx";

-- One durable lifecycle record exists for each proof operation. This prevents
-- duplicate PENDING deliveries as well as concurrent execution after restart.
CREATE UNIQUE INDEX "AnchoringIntent_proofId_operation_key"
  ON "AnchoringIntent"("proofId", "operation");

-- Create supporting indexes for query performance
CREATE INDEX "AnchoringIntent_nextRetryAt_idx" ON "AnchoringIntent"("nextRetryAt");
CREATE INDEX "AnchoringIntent_proofId_idx" ON "AnchoringIntent"("proofId");
