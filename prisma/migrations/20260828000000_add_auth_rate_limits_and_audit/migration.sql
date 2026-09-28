-- Create enum for auth event types
CREATE TYPE "AuthEventType" AS ENUM (
  'CHALLENGE_CREATED',
  'CHALLENGE_VERIFIED',
  'SIGNATURE_INVALID',
  'CHALLENGE_EXPIRED',
  'CHALLENGE_REPLAYED',
  'RATE_LIMITED'
);

-- Auth audit events table
-- Stores privacy-safe authentication events for security monitoring
-- NEVER stores: raw signatures, challenge messages, raw IP addresses, or PII
CREATE TABLE "AuthAuditEvent" (
  "id" TEXT NOT NULL,
  "eventType" "AuthEventType" NOT NULL,
  "walletHash" TEXT NOT NULL,
  "clientMetadataHash" TEXT,
  "challengeId" TEXT,
  "success" BOOLEAN NOT NULL,
  "failureReason" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "AuthAuditEvent_pkey" PRIMARY KEY ("id")
);

-- Create indexes for common queries
CREATE INDEX "AuthAuditEvent_walletHash_createdAt_idx" ON "AuthAuditEvent"("walletHash", "createdAt");
CREATE INDEX "AuthAuditEvent_eventType_createdAt_idx" ON "AuthAuditEvent"("eventType", "createdAt");
CREATE INDEX "AuthAuditEvent_createdAt_idx" ON "AuthAuditEvent"("createdAt");
