# Requirements: Payment Receipt Proof Issuance

## Introduction

The backend currently supports minimum-income proofs that aggregate multiple payments into a threshold claim. There is no mechanism to prove that a single, specific payment occurred and was received by the authenticated user. This feature adds a `POST /proofs/payment-receipt` endpoint that issues a signed `PAYMENT_RECEIPT` credential for one eligible, owned payment. Sender identity and exact payment amount are hidden by default; each can be independently disclosed by the requesting user. The credential participates in the existing expiry, revocation, optional contract anchoring, and public verification flows without modification to those subsystems.

---

## Requirements

### 1. Payment Selection and Ownership

1.1 WHEN a request is submitted with a `paymentId` that does not exist in the database THEN the system SHALL reject the request with a `404 Not Found` error and a stable `PAYMENT_NOT_FOUND` error code.

1.2 WHEN a request is submitted with a `paymentId` that exists but belongs to a different user THEN the system SHALL reject the request with a `404 Not Found` error (indistinguishable from 1.1 to the caller) and a stable `PAYMENT_NOT_FOUND` error code.

1.3 WHEN a request is submitted with a `paymentId` whose payment has `isEligible = false` THEN the system SHALL reject the request with a `422 Unprocessable Entity` error and a stable `PAYMENT_NOT_ELIGIBLE` error code.

1.4 WHEN a request is submitted with a `paymentId` whose payment has `classification = EXCLUDED` THEN the system SHALL reject the request with a `422 Unprocessable Entity` error and a stable `PAYMENT_EXCLUDED` error code.

1.5 WHEN a request is submitted with a `paymentId` whose payment is both ineligible and excluded THEN the system SHALL reject with `PAYMENT_NOT_ELIGIBLE` (ineligibility takes precedence over exclusion).

1.6 WHEN a request is submitted with a valid `paymentId` owned by the authenticated user, that payment is eligible, and is not excluded THEN the system SHALL proceed to credential issuance.

---

### 2. Disclosure Controls

2.1 WHEN `discloseSender` is absent or `false` in the request THEN the system SHALL omit the `sourceAddress` from the issued credential and SHALL record `senderHidden: true` in the stored `disclosurePolicy`.

2.2 WHEN `discloseSender` is `true` in the request THEN the system SHALL include the payment's `sourceAddress` in the issued credential and SHALL record `senderHidden: false` in the stored `disclosurePolicy`.

2.3 WHEN `discloseAmount` is absent or `false` in the request THEN the system SHALL omit the exact `amount` from the issued credential and SHALL record `amountHidden: true` in the stored `disclosurePolicy`.

2.4 WHEN `discloseAmount` is `true` in the request THEN the system SHALL decrypt the stored `amountEncrypted` value, include the plaintext amount in the issued credential, and SHALL record `amountHidden: false` in the stored `disclosurePolicy`.

2.5 WHEN either value is hidden THEN the system SHALL NOT include any field, hash, or identifier in the credential response body from which the hidden value could be derived (e.g., no partial hash of the amount, no raw `operationId` that maps directly to a public ledger lookup yielding the hidden field).

2.6 WHEN both `discloseSender` and `discloseAmount` are `false` (or absent) THEN the credential's `privacy` field SHALL contain `{ "senderHidden": true, "amountHidden": true }`.

2.7 WHEN both `discloseSender` and `discloseAmount` are `true` THEN the credential's `privacy` field SHALL contain `{ "senderHidden": false, "amountHidden": false }`.

---

### 3. Credential Schema and Versioning

3.1 WHEN a receipt proof is issued THEN the credential's `type` field SHALL be `"EarnProofPaymentReceiptCredential"`, which is distinct from the minimum-income credential type `"EarnProofMinimumIncomeCredential"`.

3.2 WHEN a receipt proof is issued THEN the credential's `schemaVersion` field SHALL be `"earnproof.payment-receipt.v1"`, which is distinct from `"earnproof.minimum-income.v1"`.

3.3 WHEN a receipt proof is stored in the `Proof` table THEN the `proofType` column SHALL be `PAYMENT_RECEIPT` and the `schemaVersion` column SHALL be `"earnproof.payment-receipt.v1"`.

3.4 WHEN the credential is built THEN the `claim` object SHALL include: `assetCode`, `assetIssuer`, `occurredAt`, and a `paymentReferenceHash` (a one-way hash of the `operationId` that allows correlation without revealing the raw ledger identifier).

3.5 WHEN `discloseSender` is `true` THEN the `claim` object SHALL additionally include `sourceAddress`.

3.6 WHEN `discloseAmount` is `true` THEN the `claim` object SHALL additionally include `amount` (plaintext decimal string matching the stored precision).

---

### 4. Signing, Hashing, and Integrity

4.1 WHEN a receipt credential is issued THEN the system SHALL canonicalize (deterministic key-sorted JSON) and HMAC-SHA256 sign it using the same `credentialSigningSecret` and signing method used for minimum-income credentials.

4.2 WHEN a receipt credential is stored THEN `credentialHash` SHALL be `sha256:<hex>` of the canonical credential, and `commitment` SHALL be `sha256:<hex>` of `credentialHash`, consistent with the existing pattern.

4.3 WHEN the `POST /proofs/payment-receipt` endpoint returns a response THEN it SHALL include `proofId`, `status`, `verificationUrl`, `credential` (signed), and `anchoring` — the same top-level shape as the minimum-income issuance response.

---

### 5. Expiry, Revocation, Anchoring, and Verification

5.1 WHEN a receipt proof is issued THEN `expiresAt` SHALL default to 30 days from issuance if `expiresInDays` is not provided, and SHALL use the caller-supplied value (1–365 days) when provided.

5.2 WHEN a receipt proof exists and `GET /proofs/:id/verify` is called THEN the system SHALL perform the same expiry check, revocation check, signature check, and optional contract status check as it does for minimum-income proofs, returning the same `VerificationResult` enum values.

5.3 WHEN `PATCH /proofs/:id/revoke` is called for a receipt proof by its owner THEN the system SHALL revoke it through the same revocation path (DB status update and optional contract revocation) used for minimum-income proofs.

5.4 WHEN contract anchoring is enabled and configured THEN a newly issued receipt proof SHALL be anchored using the same `anchorProof` call (passing `proofId`, `commitment`, `expiresAt`) used for minimum-income proofs.

5.5 WHEN `GET /proofs/:id/verify` is called for a receipt proof THEN the verification response SHALL reconstruct the credential from stored data (respecting stored `disclosurePolicy` to include or omit sender/amount) and re-validate the signature.

---

### 6. Input Validation

6.1 WHEN the request body omits `paymentId` THEN the system SHALL reject with `400 Bad Request` before any database query is performed.

6.2 WHEN `expiresInDays` is provided and is outside the range 1–365 THEN the system SHALL reject with `400 Bad Request`.

6.3 WHEN `discloseSender` or `discloseAmount` are provided with a non-boolean value THEN the system SHALL reject with `400 Bad Request`.
