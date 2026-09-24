# Database migrations

Run `npm run migration:safety` before `prisma migrate deploy`. CI runs the
same gate, then applies the complete history to a clean PostgreSQL database and
checks schema drift. The gate rejects timestamp/order collisions, duplicate SQL
checksums, and unsafe SQL. The historical `20260824000000` duplicate is
grandfathered because renaming an already-applied Prisma migration would break
production ledgers; no new duplicate timestamp is allowed.
The existing `20260825100000_store_payment_memo_context` conversion is likewise
grandfathered because editing its applied SQL changes its Prisma checksum.

Use an additive migration first: add nullable columns/tables/indexes, deploy
read/write compatibility, backfill in small batches, verify counts, then add a
constraint in a later release. A backfill must be restartable (selection from
the remaining eligible rows), bounded (fixed batch and run caps), and
observable (only counts, batches, and truncation are logged). Never log source
records or protected fields.

For indexes, use PostgreSQL's concurrent form where supported and keep the
operation in its own non-transactional migration. For a rename, deploy a new
field, dual-read/write during the compatibility window, backfill, switch
readers, then remove the old field only after the rollback window closes.

Destructive changes require a preceding compatibility release and a written
rollback or containment plan. The SQL migration must include all three markers:
`migration-safety: destructive-approved`, `migration-safety: compatibility=…`,
and `migration-safety: rollback=…`; otherwise the safety gate fails. Restore
from a tested backup or contain by disabling the incompatible code path; never
attempt an unreviewed down-migration against live data.
