# Payment Receipt Proof Issuance — Bugfix Design

## Overview

This document covers the technical design for the `PAYMENT_RECEIPT` proof type.  
The backend already handles `MINIMUM_INCOME` proofs end-to-end; this feature extends `ProofsService` and `ProofsController` with a parallel issuance path for single-payment receipt credentials. The credential is of type `EarnProofPaymentReceiptCredential`, schema version `earnproof.payment-receipt.v1`. Sender identity and exact amount can each be independently hidden or disclosed by the requesting user. All downstream flows — expiry, revocation, optional contract anchoring, and public verification — are already type-agnostic and require no changes.

---

## Glossary

- **Bug_Condition (C)**: Not applicable (this is a new feature, not a bugfix). The validation focus is on **payment eligibility conditions** that must gate issuance.
- **Property (P)**: The desired behaviour once all guards pass — a correctly shaped, signed, stored `PAYMENT_RECEIPT` credential is returned.
- **Preservation**: All existing `MINIMUM_INCOME` issuance, revocation, and verification behaviour must be completely unaffected.
- **`createPaymentReceiptProof`**: New method on `ProofsService` in `src/proofs/proofs.service.ts` that orchestrates payment lookup, validation, credential building, signing, storage, anchoring, and response assembly.
- **`disclosurePolicy`**: A JSON object stored on `ProofClaim.disclosurePolicy` that records `{ senderHidden: boolean, amountHidden: boolean }`. The verification path reads this to reconstruct the credential consistently.
- **`paymentReferenceHash`**: `sha256:<hex>` of the payment's `operationId`. Allows a verifier to correlate with the ledger without exposing the raw operation identifier.
- **`amountEncrypted`**: AES-encrypted decimal string stored on `Payment.amountEncrypted`. Decrypted only when `discloseAmount: true`.
- **`isBugCondition`**: Adapted here to mean "is the payment ineligible for issuance" — used as the gate that blocks credential creation.

---

## Bug Details

### Issuance Guard Condition

Credential issuance must be blocked when the selected payment fails any of the following checks. These are the "bug condition" equivalents — inputs for which the system must return an error rather than a credential.

**Formal Specification:**

```
FUNCTION isBlockedFromIssuance(userId, paymentId, payment)
  INPUT:
    userId    — authenticated user's ID
    paymentId — caller-supplied payment identifier
    payment   — nullable Payment row fetched with ownership filter

  OUTPUT: { blocked: boolean, reason?: string, httpStatus?: number }

  IF payment IS NULL
    RETURN { blocked: true, reason: "PAYMENT_NOT_FOUND", httpStatus: 404 }
  END IF

  // Req 1.1 / 1.2 — ownership is enforced by the query (userId filter),
  // so a missing row covers both "not found" and "belongs to another user".

  IF payment.isEligible IS false
    RETURN { blocked: true, reason: "PAYMENT_NOT_ELIGIBLE", httpStatus: 422 }
  END IF

  // Ineligibility takes precedence over exclusion (Req 1.5)

  IF payment.classification = "EXCLUDED"
    RETURN { blocked: true, reason: "PAYMENT_EXCLUDED", httpStatus: 422 }
  END IF

  RETURN { blocked: false }
END FUNCTION
```

### Examples

- **Not found / wrong owner**: `paymentId = "px_unknown"` → `404 PAYMENT_NOT_FOUND`
- **Ineligible asset**: payment exists, `isEligible = false`, `classification = EXCLUDED` → `422 PAYMENT_NOT_ELIGIBLE` (ineligibility wins)
- **Excluded only**: payment exists, `isEligible = true`, `classification = EXCLUDED` → `422 PAYMENT_EXCLUDED`
- **Happy path**: payment exists, `isEligible = true`, `classification = INCOME` → proceeds to credential issuance
- **Edge — classification UNKNOWN**: payment exists, `isEligible = true`, `classification = UNKNOWN` → proceeds (no exclusion rule applies)

---

## Expected Behavior

### Preservation Requirements

**Unchanged Behaviours:**
- `POST /proofs/minimum-income` flow, including its payment validation, credential shape, and `ProofClaim` storage, must remain identical.
- `PATCH /proofs/:id/revoke` is already type-agnostic and requires no change.
- `GET /proofs/:id/verify` is already type-agnostic for DB/contract checks; the credential reconstruction branch for `PAYMENT_RECEIPT` proofs is the only new path added.
- `ContractAnchoringService.anchorProof` signature and call site contract are unchanged.

**Scope:**
All inputs that are not `POST /proofs/payment-receipt` requests are completely unaffected. In particular: existing `MinimumIncomeCredential` signing, the `signCredential` helper, the `canonicalize` / `sortObject` helpers, and the `ProofClaim` schema are all reused without modification.

---

## Hypothesized Root Cause

Not applicable — this is a new feature. The design risks to mitigate are:

1. **Disclosure leakage**: Including `sourceAddress` or plaintext `amount` in the credential when the caller set the flag to `false`. Mitigated by building the `claim` object conditionally before signing.
2. **Verification reconstruction mismatch**: `verifyProof` rebuilding the credential without honouring the stored `disclosurePolicy`, causing a hash mismatch and a spurious `INVALID_SIGNATURE` result. Mitigated by reading `disclosurePolicy` from `ProofClaim` during reconstruction.
3. **Precedence inversion for 1.5**: Checking exclusion before eligibility. Mitigated by the explicit ordering in `isBlockedFromIssuance`.
4. **`operationId` exposure**: Returning the raw `operationId` in the credential, enabling a public ledger lookup that reveals the hidden amount or sender. Mitigated by using `paymentReferenceHash` (one-way sha256) instead.

---

## Correctness Properties

Property 1: Issuance Guard — Blocked Payments Return Errors

_For any_ request where `isBlockedFromIssuance` returns `blocked: true`, the `createPaymentReceiptProof` method SHALL throw the corresponding HTTP exception (`NotFoundException` or `UnprocessableEntityException`) with the stable error code, and SHALL NOT create any `Proof` or `ProofClaim` row.

**Validates: Requirements 1.1, 1.2, 1.3, 1.4, 1.5**

Property 2: Disclosure Fidelity — Credential Reflects Caller Flags

_For any_ valid request, the issued credential's `claim` object SHALL contain `sourceAddress` if and only if `discloseSender` is `true`, and SHALL contain `amount` if and only if `discloseAmount` is `true`. The stored `disclosurePolicy` SHALL mirror those flags as `{ senderHidden, amountHidden }`.

**Validates: Requirements 2.1, 2.2, 2.3, 2.4, 2.5, 2.6, 2.7**

Property 3: Credential Integrity — Hash and Signature are Consistent

_For any_ issued receipt credential, `sha256(canonicalize(credential))` SHALL equal the `credentialHash` stored on the `Proof` row, and `sha256(credentialHash)` SHALL equal the stored `commitment`.

**Validates: Requirements 4.1, 4.2**

Property 4: Verification Reconstruction — Signature Remains Valid

_For any_ receipt proof that has not been tampered with, `GET /proofs/:id/verify` SHALL reconstruct the credential from stored data, re-compute the hash, match `credentialHash`, and return `VerificationResult.VALID` (absent expiry/revocation).

**Validates: Requirements 5.2, 5.5**

Property 5: Preservation — Minimum-Income Proofs Are Unaffected

_For any_ input that targets the minimum-income issuance or verification path, the system SHALL produce exactly the same result as before this feature was introduced.

**Validates: Requirements 5.2, 5.3, 5.4**

---

## Fix Implementation

### 1. New DTO: `CreatePaymentReceiptProofDto`

**File**: `src/proofs/dto/create-payment-receipt-proof.dto.ts`

```typescript
import { IsBoolean, IsInt, IsOptional, IsString, Max, Min } from "class-validator";

export class CreatePaymentReceiptProofDto {
  @IsString()
  paymentId!: string;

  @IsOptional()
  @IsBoolean()
  discloseSender?: boolean;

  @IsOptional()
  @IsBoolean()
  discloseAmount?: boolean;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(365)
  expiresInDays?: number;
}
```

Satisfies requirements 6.1 (missing `paymentId` → 400), 6.2 (`expiresInDays` range), 6.3 (non-boolean flags → 400). NestJS `ValidationPipe` handles all three.

---

### 2. TypeScript type: `PaymentReceiptCredential`

**File**: `src/proofs/proofs.service.ts` (add alongside `MinimumIncomeCredential`)

```typescript
type PaymentReceiptCredential = {
  id: string;
  type: "EarnProofPaymentReceiptCredential";
  schemaVersion: "earnproof.payment-receipt.v1";
  issuer: "earnproof-backend";
  subject: { walletHash: string };
  claim: {
    assetCode: string;
    assetIssuer: string | null;
    occurredAt: string;
    paymentReferenceHash: string;
    sourceAddress?: string;   // present only when discloseSender = true
    amount?: string;          // present only when discloseAmount = true
  };
  privacy: {
    senderHidden: boolean;
    amountHidden: boolean;
  };
  issuedAt: string;
  expiresAt: string;
};
```

---

### 3. New service method: `createPaymentReceiptProof`

**File**: `src/proofs/proofs.service.ts`

**Algorithm:**

```
FUNCTION createPaymentReceiptProof(user, dto)

  // 1. Fetch payment with ownership filter
  payment ← prisma.payment.findFirst({
    where: { id: dto.paymentId, userId: user.id },
    select: { id, operationId, sourceAddress, assetCode, assetIssuer,
              amountEncrypted, classification, isEligible, occurredAt }
  })

  // 2. Issuance guards (Req 1.1–1.5)
  IF payment IS NULL
    THROW NotFoundException("Payment not found", "PAYMENT_NOT_FOUND")
  IF NOT payment.isEligible
    THROW UnprocessableEntityException("Payment not eligible", "PAYMENT_NOT_ELIGIBLE")
  IF payment.classification = EXCLUDED
    THROW UnprocessableEntityException("Payment is excluded", "PAYMENT_EXCLUDED")

  // 3. Resolve disclosure flags
  senderHidden ← NOT (dto.discloseSender ?? false)
  amountHidden ← NOT (dto.discloseAmount ?? false)

  // 4. Optionally decrypt amount
  plaintextAmount ← amountHidden
    ? undefined
    : decryptProtectedAmount(payment.amountEncrypted, paymentEncryptionKey)

  // 5. Build draft credential (no proof field yet)
  now ← new Date()
  expiresAt ← now + (dto.expiresInDays ?? 30) days
  proofId ← randomUUID()

  draftCredential ← {
    id: proofId,
    type: "EarnProofPaymentReceiptCredential",
    schemaVersion: "earnproof.payment-receipt.v1",
    issuer: "earnproof-backend",
    subject: { walletHash: user.walletHash },
    claim: {
      assetCode: payment.assetCode,
      assetIssuer: payment.assetIssuer,
      occurredAt: payment.occurredAt.toISOString(),
      paymentReferenceHash: "sha256:" + sha256(payment.operationId),
      ...(NOT senderHidden ? { sourceAddress: payment.sourceAddress } : {}),
      ...(NOT amountHidden ? { amount: plaintextAmount } : {})
    },
    privacy: { senderHidden, amountHidden },
    issuedAt: now.toISOString(),
    expiresAt: expiresAt.toISOString()
  }

  // 6. Compute hashes
  credentialHash ← "sha256:" + sha256(canonicalize(draftCredential))
  commitment     ← "sha256:" + sha256(credentialHash)

  // 7. Persist Proof + ProofClaim
  proof ← prisma.proof.create({
    id: proofId,
    userId: user.id,
    proofType: PAYMENT_RECEIPT,
    schemaVersion: "earnproof.payment-receipt.v1",
    status: ACTIVE,
    network: stellarNetwork,
    assetCode: payment.assetCode,
    assetIssuer: payment.assetIssuer,
    expiresAt,
    credentialHash,
    commitment,
    claim: {
      create: {
        operator: "eq",
        result: true,
        disclosurePolicy: { senderHidden, amountHidden }
      }
    }
  })

  // 8. Sign
  signedCredential ← signCredential(draftCredential)

  // 9. Optional contract anchoring
  anchorResult ← contractAnchoringService?.anchorProof({
    proofId: proof.id, commitment: proof.commitment, expiresAt: proof.expiresAt
  })
  IF anchorResult?.anchored
    prisma.proof.update({ contractTransactionHash: anchorResult.transactionHash })

  // 10. Return
  RETURN {
    proofId: proof.id,
    status: proof.status,
    verificationUrl: "/api/v1/proofs/" + proof.id + "/verify",
    credential: signedCredential,
    anchoring: anchorResult ?? { anchored: false, reason: "disabled" }
  }
END FUNCTION
```

**Key design decisions:**
- `signCredential` is overloaded to accept `MinimumIncomeCredential | PaymentReceiptCredential`. Since it only calls `canonicalize` (which is type-agnostic) and spreads the credential, no structural change is needed beyond widening the parameter type.
- The draft credential is built once and reused for both hashing and signing — the hash in `credentialHash` is of the unsigned credential, matching the minimum-income pattern exactly.
- `prisma.payment.findFirst` (not `findUnique`) is used so that the `userId` ownership filter is applied in the same query, keeping requirements 1.1 and 1.2 indistinguishable to the caller.

---

### 4. Verification reconstruction for `PAYMENT_RECEIPT` proofs

**File**: `src/proofs/proofs.service.ts` — `verifyProof` method

The existing `verifyProof` currently calls `buildCredential` (minimum-income only) unconditionally. Add a branch:

```
IF proof.proofType = PAYMENT_RECEIPT
  credential ← buildReceiptCredential(proof, disclosurePolicy)
ELSE
  credential ← buildCredential(...)   // existing path, unchanged
END IF
```

`buildReceiptCredential` reads the stored `disclosurePolicy` from `proof.claim.disclosurePolicy` to decide whether to include `sourceAddress` / `amount`. The payment's `sourceAddress`, `occurredAt`, `operationId`, and `amountEncrypted` must be joined when loading the proof. This requires adding a `payment` relation to `Proof` **or** storing the needed fields denormalised on the credential at issuance time.

**Chosen approach — store necessary fields in `ProofClaim.disclosurePolicy`:**

Extend the stored `disclosurePolicy` JSON for receipt proofs to include:

```json
{
  "senderHidden": true,
  "amountHidden": false,
  "assetCode": "USDC",
  "assetIssuer": "GA...",
  "occurredAt": "2026-08-03T12:00:00.000Z",
  "paymentReferenceHash": "sha256:abc...",
  "sourceAddress": "GB...",   // present only when senderHidden = false
  "amount": "125.50"          // present only when amountHidden = false
}
```

This keeps the verification path free from additional DB joins and is consistent with the minimum-income pattern of storing `qualifyingPaymentCount` in `disclosurePolicy`. Fields that are hidden are simply absent.

---

### 5. Controller route

**File**: `src/proofs/proofs.controller.ts`

```typescript
@ApiBearerAuth()
@UseGuards(AuthGuard)
@Post("payment-receipt")
createPaymentReceiptProof(
  @CurrentUser() user: AuthenticatedUser,
  @Body() body: CreatePaymentReceiptProofDto,
) {
  return this.proofsService.createPaymentReceiptProof(user, body);
}
```

No module changes are needed — `ProofsModule` already provides `ProofsService` and `ContractAnchoringService`.

---

### 6. Error shape convention

The existing service throws NestJS built-ins directly (e.g. `BadRequestException`, `NotFoundException`). For the stable error codes required by requirements 1.1–1.4, use the two-argument constructors:

```typescript
throw new NotFoundException(
  { message: "Payment not found", code: "PAYMENT_NOT_FOUND" },
  "Not Found",
);

throw new UnprocessableEntityException(
  { message: "Payment is not eligible", code: "PAYMENT_NOT_ELIGIBLE" },
  "Unprocessable Entity",
);
```

This follows the existing NestJS error-response shape without requiring a custom exception filter.

---

### 7. Prisma schema changes

**No schema migrations are required.** The `ProofType.PAYMENT_RECEIPT` enum value already exists in `schema.prisma`. The additional data for receipt proofs (`sourceAddress`, `occurredAt`, `paymentReferenceHash`) is stored inside the existing `ProofClaim.disclosurePolicy` JSON field, following the established pattern. `Proof.periodStart` and `Proof.periodEnd` are left `null` for receipt proofs (they are optional in the schema).

---

## Testing Strategy

### Validation Approach

Testing follows the two-phase structure: first exercise the guard conditions (confirm correct rejection), then exercise the happy path (confirm correct credential construction and preservation of existing behaviour).

---

### Exploratory Bug Condition Checking

**Goal**: Confirm the guards in `isBlockedFromIssuance` fire for every blocked input before the happy-path code is reached.

**Test Cases** (to be placed in `proofs.service.spec.ts`):

1. **Not found**: `paymentId` does not exist in DB → expect `NotFoundException` with code `PAYMENT_NOT_FOUND`.
2. **Wrong owner**: payment exists but `userId` differs → same `NotFoundException` (indistinguishable).
3. **Ineligible only**: `isEligible = false`, `classification = INCOME` → `UnprocessableEntityException` with code `PAYMENT_NOT_ELIGIBLE`.
4. **Excluded only**: `isEligible = true`, `classification = EXCLUDED` → `UnprocessableEntityException` with code `PAYMENT_EXCLUDED`.
5. **Ineligible and excluded**: `isEligible = false`, `classification = EXCLUDED` → `PAYMENT_NOT_ELIGIBLE` (precedence check).

**Expected counterexamples on unfixed (pre-feature) code**: method does not exist yet, so all five throw `TypeError: service.createPaymentReceiptProof is not a function`.

---

### Fix Checking

**Goal**: Verify that for all inputs where no guard fires, the issued credential is correctly shaped, signed, and stored.

```
FOR ALL input WHERE isBlockedFromIssuance(input) = { blocked: false } DO
  result := createPaymentReceiptProof(user, input)
  ASSERT result.status = ACTIVE
  ASSERT result.credential.type = "EarnProofPaymentReceiptCredential"
  ASSERT result.credential.schemaVersion = "earnproof.payment-receipt.v1"
  ASSERT result.credential.proof.credentialHash MATCHES /^sha256:/
  ASSERT result.credential.proof.signature MATCHES /^hmac-sha256:/
  ASSERT result.credential.claim.paymentReferenceHash MATCHES /^sha256:/
  ASSERT result.credential.claim contains no raw operationId
END FOR
```

---

### Preservation Checking

**Goal**: Verify that the minimum-income path is completely unaffected.

```
FOR ALL input WHERE input targets createMinimumIncomeProof DO
  ASSERT createMinimumIncomeProof(user, input) = same result as before feature
END FOR
```

**Testing approach**: Re-run existing `proofs.service.spec.ts` and `proofs.lifecycle.spec.ts` suites without modification. A regression here is a direct violation of Property 5.

---

### Unit Tests

Add to `src/proofs/proofs.service.spec.ts`:

- **Disclosure off (default)**: call with `discloseSender` and `discloseAmount` absent → credential contains neither `sourceAddress` nor `amount`; `privacy = { senderHidden: true, amountHidden: true }`.
- **Disclosure on**: call with `discloseSender: true, discloseAmount: true` → credential contains both `sourceAddress` and decrypted `amount`; `privacy = { senderHidden: false, amountHidden: false }`.
- **Mixed disclosure**: `discloseSender: false, discloseAmount: true` → only `amount` present.
- **`paymentReferenceHash` is one-way**: assert `result.credential.claim.paymentReferenceHash` equals `"sha256:" + sha256(payment.operationId)` and that the raw `operationId` does not appear anywhere in `JSON.stringify(result)`.
- **Credential hash integrity**: compute `sha256(canonicalize(credential_without_proof_field))` and assert it matches `result.credential.proof.credentialHash`.
- **Expiry default**: call without `expiresInDays` → `expiresAt` is within ±5 seconds of `now + 30 days`.
- **Expiry custom**: call with `expiresInDays: 7` → `expiresAt` is within ±5 seconds of `now + 7 days`.
- **Guard: not found** (see Exploratory section above).
- **Guard: ineligible** (see Exploratory section above).
- **Guard: excluded** (see Exploratory section above).
- **Guard: ineligible + excluded precedence** (see Exploratory section above).
- **Anchoring propagation**: when `ContractAnchoringService.anchorProof` returns `{ anchored: true, transactionHash: "tx_1" }`, assert `result.anchoring.transactionHash = "tx_1"` and `prisma.proof.update` is called with `{ contractTransactionHash: "tx_1" }`.
- **Anchoring disabled**: when no `ContractAnchoringService` injected, assert `result.anchoring = { anchored: false, reason: "disabled" }`.

### Property-Based Tests

Add to `src/proofs/proofs.lifecycle.spec.ts` (new describe block):

- **Lifecycle — receipt proof**: create → verify → revoke → re-verify, asserting `ACTIVE` → `VALID` → `REVOKED` → `REVOKED` state transitions (mirrors the minimum-income lifecycle test).
- **Disclosure consistency round-trip**: for all four combinations of `{discloseSender, discloseAmount}`, create a proof, then call `verifyProof`. Assert that `result.result = VALID` and that the credential returned by verify contains exactly the same `sourceAddress` / `amount` presence as the issuance response — no more, no less.

### Integration Tests

End-to-end (manual or e2e test suite):

1. **Full receipt proof flow**: `POST /payments/sync` → `PATCH /payments/:id/classification` → `POST /proofs/payment-receipt` → `GET /proofs/:id/verify` → `PATCH /proofs/:id/revoke` → `GET /proofs/:id/verify` (expect revoked).
2. **Disclosure headers in HTTP response**: verify that when `discloseAmount: false`, the raw encrypted string does not appear in the HTTP response body.
3. **400 on missing `paymentId`**: send `{}` to `POST /proofs/payment-receipt` and assert 400.
4. **400 on out-of-range `expiresInDays`**: send `expiresInDays: 366` and assert 400.
