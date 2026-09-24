-- Convert legacy plain-text payment memos into bounded structured JSON.
ALTER TABLE "Payment"
ALTER COLUMN "memo" TYPE JSONB
USING (
  CASE
    WHEN "memo" IS NULL THEN NULL
    ELSE jsonb_build_object(
      'type', 'text',
      'value', LEFT("memo", 500),
      'truncated', LENGTH("memo") > 500
    )
  END
);
