# Representative populated prior version fixture

This fixture represents a deployment before `20260825100000_store_payment_memo_context`:
`Payment.memo` is plain text and rows are already populated. Upgrade validation
must prove the migration converts valid values with `USING`, retains row counts,
and leaves no plaintext memo in application logs.
