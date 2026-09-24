-- Migration: add_auth_sessions
-- Introduces persisted, revocable authentication sessions.
-- Only a SHA-256 hex digest of the opaque bearer token is stored;
-- the raw token is never written to the database.

-- CreateTable
CREATE TABLE "AuthSession" (
    "id"          TEXT        NOT NULL,
    "tokenHash"   TEXT        NOT NULL,
    "userId"      TEXT        NOT NULL,
    "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt"   TIMESTAMP(3) NOT NULL,
    "lastUsedAt"  TIMESTAMP(3),
    "revokedAt"   TIMESTAMP(3),
    "rotatedToId" TEXT,

    CONSTRAINT "AuthSession_pkey" PRIMARY KEY ("id")
);

-- Unique constraint: each token hash must be globally unique
CREATE UNIQUE INDEX "AuthSession_tokenHash_key"   ON "AuthSession"("tokenHash");

-- Unique constraint: a session can rotate to at most one successor
CREATE UNIQUE INDEX "AuthSession_rotatedToId_key" ON "AuthSession"("rotatedToId");

-- Performance indexes
-- Lookup by user (listing active sessions, logout-all)
CREATE INDEX "AuthSession_userId_idx"    ON "AuthSession"("userId");
-- Cleanup job: delete / flag expired rows efficiently
CREATE INDEX "AuthSession_expiresAt_idx" ON "AuthSession"("expiresAt");
-- Partial scan for active (non-revoked) sessions
CREATE INDEX "AuthSession_revokedAt_idx" ON "AuthSession"("revokedAt");

-- ForeignKey: session belongs to a user
ALTER TABLE "AuthSession"
    ADD CONSTRAINT "AuthSession_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

-- ForeignKey: rotation self-reference (session → its replacement)
ALTER TABLE "AuthSession"
    ADD CONSTRAINT "AuthSession_rotatedToId_fkey"
    FOREIGN KEY ("rotatedToId") REFERENCES "AuthSession"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;
