-- Persist encrypted webhook secrets and durable signed delivery attempts.
ALTER TABLE "Webhook" RENAME COLUMN "secretHash" TO "secretEncrypted";

CREATE TYPE "WebhookDeliveryStatus" AS ENUM ('PENDING', 'SUCCESS', 'FAILED');

CREATE TABLE "WebhookDelivery" (
    "id"            TEXT NOT NULL,
    "webhookId"     TEXT NOT NULL,
    "eventType"     TEXT NOT NULL,
    "eventId"       TEXT NOT NULL,
    "payload"       JSONB NOT NULL,
    "attempt"       INTEGER NOT NULL DEFAULT 1,
    "status"        "WebhookDeliveryStatus" NOT NULL DEFAULT 'PENDING',
    "statusCode"    INTEGER,
    "responseBody"  TEXT,
    "durationMs"    INTEGER,
    "failureReason" TEXT,
    "replayOf"      TEXT,
    "replayedBy"    TEXT,
    "replayKey"     TEXT,
    "deliveredAt"   TIMESTAMP(3),
    "nextRetryAt"   TIMESTAMP(3),
    "createdAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "WebhookDelivery_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "WebhookDelivery"
    ADD CONSTRAINT "WebhookDelivery_webhookId_fkey"
    FOREIGN KEY ("webhookId") REFERENCES "Webhook"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE UNIQUE INDEX "WebhookDelivery_replayKey_key" ON "WebhookDelivery"("replayKey");
CREATE INDEX "WebhookDelivery_webhookId_createdAt_idx" ON "WebhookDelivery"("webhookId", "createdAt");
CREATE INDEX "WebhookDelivery_eventId_idx" ON "WebhookDelivery"("eventId");
CREATE INDEX "WebhookDelivery_status_nextRetryAt_idx" ON "WebhookDelivery"("status", "nextRetryAt");
