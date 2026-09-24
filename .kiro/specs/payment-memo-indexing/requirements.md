# Requirements Document

## Introduction

Stellar payment operations are currently indexed without their parent transaction memo. Memos are short, optional fields attached at the transaction level and often carry human-readable context (e.g., "Salary June", invoice numbers, reference codes) that workers use to manually classify income. Because memos may contain sensitive or malformed content and must never appear in public proof or verification responses, enrichment requires explicit normalization, bounded storage, and strict privacy controls.

This feature adds memo enrichment to the payment sync flow: after collecting a batch of payment operations from Horizon, the Sync_Processor deduplicates transaction lookups, fetches each parent transaction once, normalizes the memo according to its type, enforces size and encoding limits, and stores a safe memo representation alongside the payment. The stored value is exposed only to the authenticated wallet owner through the owner-facing payment list and detail endpoints and is excluded from all credential and verification outputs by default.

## Glossary

- **Sync_Processor**: The component that orchestrates a payment sync run, from fetching Horizon operations to persisting normalized payments in the database. Currently lives in `PaymentsService.syncPayments`.
- **StellarService**: The service responsible for all Horizon HTTP communication, including fetching payment operations and, after this feature, fetching parent transactions.
- **Memo_Normalizer**: The pure function (or set of functions) that converts a raw Horizon transaction memo field into a `NormalizedMemo` value. To be introduced in `src/stellar/`.
- **NormalizedMemo**: A discriminated union representing the canonical in-process memo representation: `none`, `text`, `id`, `hash`, or `return_hash`.
- **MemoContext**: The bounded, persisted representation stored in the `Payment.memo` column. A JSON-serializable object limited to 255 characters in its string fields.
- **Payment_DTO**: The response shape returned by `GET /payments` and `GET /payments/:id` to the authenticated owner.
- **MinimumIncomeCredential**: The signed JSON credential produced by `ProofsService` and returned in proof creation and verification responses.
- **Horizon**: The Stellar network HTTP API, accessed at the configured `STELLAR_HORIZON_URL`.
- **Owner**: The authenticated user who owns the wallet associated with a set of payments.

---

## Requirements

### Requirement 1: Memo Type Normalization

**User Story:** As a worker, I want every payment to carry a predictable memo representation so that I can read classification hints without encountering raw Horizon fields or encoding errors.

#### Acceptance Criteria

1. THE Memo_Normalizer SHALL produce a `NormalizedMemo` of type `none` when the Horizon transaction carries no memo field or when the memo type is `none`.
2. WHEN the Horizon transaction memo type is `text`, THE Memo_Normalizer SHALL produce a `NormalizedMemo` of type `text` containing the decoded string value.
3. WHEN the Horizon transaction memo type is `id`, THE Memo_Normalizer SHALL produce a `NormalizedMemo` of type `id` containing the numeric string value.
4. WHEN the Horizon transaction memo type is `hash`, THE Memo_Normalizer SHALL produce a `NormalizedMemo` of type `hash` containing the base64-encoded 32-byte value.
5. WHEN the Horizon transaction memo type is `return`, THE Memo_Normalizer SHALL produce a `NormalizedMemo` of type `return_hash` containing the base64-encoded 32-byte value.
6. WHEN the decoded memo text contains invalid UTF-8 sequences, THE Memo_Normalizer SHALL replace invalid bytes with the Unicode replacement character (U+FFFD) rather than throwing.
7. WHEN a memo text value exceeds 500 characters after decoding, THE Memo_Normalizer SHALL truncate the value to 500 characters and set a `truncated` flag to `true` on the resulting `NormalizedMemo`.
8. THE Memo_Normalizer SHALL treat any unrecognized memo type as equivalent to `none`.

---

### Requirement 2: Transaction Fetch Deduplication

**User Story:** As a system operator, I want memo-enrichment network calls kept to a minimum so that a sync run does not generate redundant Horizon requests for the same transaction hash.

#### Acceptance Criteria

1. WHEN multiple payment operations in a single sync run share the same `stellarTransactionHash`, THE Sync_Processor SHALL fetch the parent transaction from Horizon exactly once per unique hash.
2. THE StellarService SHALL expose a method `fetchTransaction(transactionHash: string)` that returns the raw Horizon transaction record for the given hash.
3. THE Sync_Processor SHALL maintain an in-memory cache of transaction hash to `NormalizedMemo` mappings for the duration of each sync run.
4. WHEN the in-memory cache already contains an entry for a given `stellarTransactionHash`, THE Sync_Processor SHALL use the cached `NormalizedMemo` without issuing an additional Horizon request.

---

### Requirement 3: Resilient Enrichment — Failure Isolation

**User Story:** As a worker, I want my payment sync to complete even when individual memo lookups fail so that transient Horizon errors or malformed data do not prevent new payments from being indexed.

#### Acceptance Criteria

1. WHEN a Horizon request for a parent transaction returns a non-2xx status code, THE Sync_Processor SHALL store a `NormalizedMemo` of type `none` for all payments sharing that transaction hash and SHALL continue processing remaining payments.
2. WHEN a Horizon request for a parent transaction throws a network-level error, THE Sync_Processor SHALL store a `NormalizedMemo` of type `none` for the affected payments and SHALL continue processing remaining payments.
3. WHEN the Horizon transaction record for a given hash is missing or null, THE Sync_Processor SHALL store a `NormalizedMemo` of type `none` for the affected payments without propagating an error.
4. IF memo enrichment for any payment fails, THEN THE Sync_Processor SHALL increment an `enrichmentErrors` counter in the sync result and SHALL NOT roll back any previously persisted payments.
5. THE Sync_Processor SHALL include an `enrichmentErrors` field in the object returned by `syncPayments`, set to `0` when no failures occurred.

---

### Requirement 4: Bounded and Protected Memo Storage

**User Story:** As a privacy-conscious worker, I want stored memo data to be bounded and handled according to its sensitivity so that the database never holds unbounded or uncontrolled text from the Stellar network.

#### Acceptance Criteria

1. THE Sync_Processor SHALL persist memo data in the existing `Payment.memo` column as a JSON-serializable `MemoContext` object.
2. THE `MemoContext` object SHALL contain a `type` field whose value is one of `none`, `text`, `id`, `hash`, or `return_hash`.
3. WHEN the `MemoContext` type is `text`, THE `MemoContext` object SHALL contain a `value` field whose length does not exceed 500 characters and a `truncated` boolean field.
4. WHEN the `MemoContext` type is `id`, THE `MemoContext` object SHALL contain a `value` field holding the numeric string.
5. WHEN the `MemoContext` type is `hash` or `return_hash`, THE `MemoContext` object SHALL contain a `value` field holding the base64-encoded hash string.
6. WHEN the `MemoContext` type is `none`, THE `MemoContext` object SHALL contain no `value` field.
7. THE Sync_Processor SHALL store `MemoContext` objects only; raw Horizon memo fields SHALL NOT be persisted to the database.

---

### Requirement 5: Owner-Only Memo Exposure in Payment DTOs

**User Story:** As a worker, I want to see memo context on my payments so that I can use it as a classification hint, while being confident that no other party can access this information.

#### Acceptance Criteria

1. WHEN an authenticated Owner calls `GET /payments`, THE Payment_DTO returned for each payment SHALL include a `memoContext` field containing the `MemoContext` object.
2. WHEN an authenticated Owner calls `GET /payments/:id`, THE Payment_DTO SHALL include a `memoContext` field containing the `MemoContext` object for the requested payment.
3. THE `memoContext` field SHALL be omitted from any response that is not explicitly scoped to an authenticated Owner request.

---

### Requirement 6: Memo Exclusion from Public Credentials and Verification Responses

**User Story:** As a verifier, I want proof credentials and verification responses to be free of memo data so that workers' payment context and sensitive memos are never disclosed to third parties.

#### Acceptance Criteria

1. THE ProofsService SHALL NOT include any `MemoContext` data or `memo` field in the `MinimumIncomeCredential` payload used for signing.
2. WHEN a verifier calls `GET /proofs/:id/verify`, THE verification response SHALL NOT include any `MemoContext` data or `memo` field in the credential or proof objects.
3. THE ProofsService SHALL NOT read the `Payment.memo` column when constructing or evaluating proofs.
4. WHEN selecting payments for proof construction, THE ProofsService SHALL NOT expose memo data in any intermediate computation result that is logged or returned to callers.

---

### Requirement 7: Test Coverage

**User Story:** As a developer, I want comprehensive tests so that memo normalization, deduplication, failure isolation, and privacy boundaries are verified automatically on every build.

#### Acceptance Criteria

1. THE test suite SHALL include a unit test for each of the five `NormalizedMemo` types produced by the Memo_Normalizer.
2. THE test suite SHALL include a unit test verifying that invalid UTF-8 in a text memo produces a `text`-type `NormalizedMemo` with replacement characters rather than an error.
3. THE test suite SHALL include a unit test verifying that a text memo exceeding 500 characters is truncated to 500 characters with `truncated: true`.
4. THE test suite SHALL include a unit test verifying that two payment operations sharing the same `stellarTransactionHash` in one sync run result in exactly one Horizon transaction fetch.
5. THE test suite SHALL include unit tests verifying that a Horizon non-2xx response, a network error, and a missing transaction record each produce a `none`-type `NormalizedMemo` without aborting the sync.
6. THE test suite SHALL include a privacy regression test verifying that the `MinimumIncomeCredential` payload and the public verification response do not contain any `memo` or `memoContext` field.
7. WHEN `npm run lint`, `npm run test -- --runInBand`, and `npm run build` are executed, THE build pipeline SHALL exit with code 0.
