ALTER TABLE "Issuer"
ADD COLUMN "publicMetadata" JSONB,
ADD COLUMN "contractSyncState" TEXT NOT NULL DEFAULT 'PENDING',
ADD COLUMN "contractSyncedStatus" "ResourceStatus",
ADD COLUMN "contractTransactionHash" TEXT,
ADD COLUMN "contractSyncedAt" TIMESTAMP(3),
ADD COLUMN "contractSyncError" TEXT;
