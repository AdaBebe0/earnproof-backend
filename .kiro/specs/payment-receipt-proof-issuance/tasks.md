# Implementation Plan

- [ ] 1. Write bug condition exploration test
  - **Property 1: Bug Condition** - Issuance Guard Blocks Invalid Payments
  - **CRITICAL**: This test MUST FAIL on unfixed (pre-feature) code — failure confirms the feature gap exists
  - **DO NOT attempt to fix the test or the code when it fails**
  - **NOTE**: This test encodes the expected guard behaviour — it will validate the fix when it passes after implementation
  - **GOAL**: Surface counterexamples that demonstrate each blocked-issuance case
  - **Scoped PBT Approach**: Scope to concrete failing cases — one case per guard condition (not-found, wrong-owner, ineligible, excluded, ineligible+excluded)
  - Add a `describe('createPaymentReceiptProof — issuance guards', ...)` block in `src/proofs/proofs.service.spec.ts`
  - Test 1: call with `paymentId` that does not exist → expect `NotFoundException` with code `PAYMENT_NOT_FOUND`
  - Test 2: call with `paymentId` belonging to a different user (ownership filter makes it look missing) → expect same `NotFoundException`
  - Test 3: call with `isEligible: false`, `classification: INCOME` → expect `UnprocessableEntityException` with code `PAYMENT_NOT_ELIGIBLE`
  - Test 4: call with `isEligible: true`, `classification: EXCLUDED` → expect `UnprocessableEntityException` with code `PAYMENT_EXCLUDED`
  - Test 5 (precedence): call with `isEligible: false`, `classification: EXCLUDED` → expect `PAYMENT_NOT_ELIGIBLE` not `PAYMENT_EXCLUDED`
  - Run tests on UNFIXED code (`createPaymentReceiptProof` does not yet exist)
  - **EXPECTED OUTCOME**: All five tests FAIL with `TypeError: service.createPaymentReceiptProof is not a function` (this is correct — confirms the gap)
  - Document the counterexamples to understand what the implementation must satisfy
  - Mark task complete when tests are written, run, and failures are documented
  - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.5_

- [ ] 2. Write preservation property tests (BEFORE implementing fix)
  - **Property 2: Preservation** - Minimum-Income Path Is Completely Unaffected
  - **IMPORTANT**: Follow observation-first methodology
  - Observe: run `npm test -- --testPathPattern=proofs.service.spec --runInBand` on the current (pre-feature) codebase and record all passing minimum-income test results
  - Observe: run `npm test -- --testPathPattern=proofs.lifecycle.spec --runInBand` and record passing lifecycle test results
  - These existing suites ARE the preservation tests — do not modify them
  - Confirm every existing test in `proofs.service.spec.ts` and `proofs.lifecycle.spec.ts` passes on the unfixed codebase
  - **EXPECTED OUTCOME**: All existing tests PASS (this is the baseline to preserve)
  - Mark task complete when baseline passing state is confirmed and documented
  - _Requirements: 5.2, 5.3, 5.4_

- [ ] 3. Add `CreatePaymentReceiptProofDto`

  - [ ] 3.1 Create `src/proofs/dto/create-payment-receipt-proof.dto.ts`
    - Add `paymentId: string` decorated with `@IsString()`
    - Add optional `discloseSender?: boolean` decorated with `@IsOptional() @IsBoolean()`
    - Add optional `discloseAmount?: boolean` decorated with `@IsOptional() @IsBoolean()`
    - Add optional `expiresInDays?: number` decorated with `@IsOptional() @IsInt() @Min(1) @Max(365)`
    - Import validators from `class-validator` matching the pattern in `create-minimum-income-proof.dto.ts`
    - _Bug_Condition: missing/invalid paymentId or out-of-range expiresInDays_
    - _Requirements: 6.1, 6.2, 6.3_

- [ ] 4. Add `PaymentReceiptCredential` type and widen `signCredential`

  - [ ] 4.1 Add `PaymentReceiptCredential` TypeScript type in `src/proofs/proofs.service.ts`
    - Place it alongside `MinimumIncomeCredential`
    - Fields: `id`, `type: "EarnProofPaymentReceiptCredential"`, `schemaVersion: "earnproof.payment-receipt.v1"`, `issuer: "earnproof-backend"`, `subject: { walletHash: string }`, `claim` (with `assetCode`, `assetIssuer`, `occurredAt`, `paymentReferenceHash`, optional `sourceAddress`, optional `amount`), `privacy: { senderHidden: boolean, amountHidden: boolean }`, `issuedAt`, `expiresAt`
    - _Requirements: 3.1, 3.2, 3.4, 3.5, 3.6_

  - [ ] 4.2 Widen `signCredential` parameter type in `src/proofs/proofs.service.ts`
    - Change parameter type from `MinimumIncomeCredential` to `MinimumIncomeCredential | PaymentReceiptCredential`
    - No logic change — `canonicalize` is already type-agnostic
    - _Requirements: 4.1_

- [ ] 5. Implement `createPaymentReceiptProof` in `ProofsService`

  - [ ] 5.1 Add `RECEIPT_SCHEMA_VERSION = "earnproof.payment-receipt.v1"` constant alongside `SCHEMA_VERSION`
    - _Requirements: 3.2, 3.3_

  - [ ] 5.2 Implement ownership fetch with eligibility and exclusion guards
    - Use `prisma.payment.findFirst({ where: { id: dto.paymentId, userId: user.id }, select: { ... } })` selecting `id`, `operationId`, `sourceAddress`, `assetCode`, `assetIssuer`, `amountEncrypted`, `classification`, `isEligible`, `occurredAt`
    - IF null → `throw new NotFoundException({ message: 'Payment not found', code: 'PAYMENT_NOT_FOUND' }, 'Not Found')`
    - IF `!payment.isEligible` → `throw new UnprocessableEntityException({ message: 'Payment is not eligible', code: 'PAYMENT_NOT_ELIGIBLE' }, 'Unprocessable Entity')`
    - IF `payment.classification === PaymentClassification.EXCLUDED` → `throw new UnprocessableEntityException({ message: 'Payment is excluded', code: 'PAYMENT_EXCLUDED' }, 'Unprocessable Entity')`
    - _Bug_Condition: isBugCondition(payment) = null OR !isEligible OR classification=EXCLUDED_
    - _Expected_Behavior: NotFoundException(PAYMENT_NOT_FOUND) | UnprocessableEntityException(PAYMENT_NOT_ELIGIBLE) | UnprocessableEntityException(PAYMENT_EXCLUDED)_
    - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.5_

  - [ ] 5.3 Resolve disclosure flags and optionally decrypt amount
    - `senderHidden = !(dto.discloseSender ?? false)`
    - `amountHidden = !(dto.discloseAmount ?? false)`
    - If `!amountHidden`: decrypt via `decryptProtectedAmount(payment.amountEncrypted, this.paymentEncryptionKey)`; wrap in try/catch and throw `BadRequestException` on failure
    - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.5, 2.6, 2.7_

  - [ ] 5.4 Build draft `PaymentReceiptCredential`
    - Compute `paymentReferenceHash = "sha256:" + sha256(payment.operationId)`
    - Build `claim` conditionally: always include `assetCode`, `assetIssuer`, `occurredAt`, `paymentReferenceHash`; spread `sourceAddress` only when `!senderHidden`; spread `amount` only when `!amountHidden`
    - Set `privacy: { senderHidden, amountHidden }`
    - Use `randomUUID()` for `proofId`; compute `expiresAt` from `dto.expiresInDays ?? DEFAULT_EXPIRY_DAYS`
    - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.5, 2.6, 2.7, 3.1, 3.2, 3.4, 3.5, 3.6_

  - [ ] 5.5 Compute hashes and persist `Proof` + `ProofClaim`
    - `credentialHash = "sha256:" + sha256(canonicalize(draftCredential))`
    - `commitment = "sha256:" + sha256(credentialHash)`
    - `prisma.proof.create` with `proofType: ProofType.PAYMENT_RECEIPT`, `schemaVersion: RECEIPT_SCHEMA_VERSION`; `periodStart` and `periodEnd` left as `undefined` (nullable in schema)
    - `ProofClaim.disclosurePolicy` stores: `{ senderHidden, amountHidden, assetCode, assetIssuer, occurredAt, paymentReferenceHash, ...(sourceAddress if !senderHidden), ...(amount if !amountHidden) }`
    - _Bug_Condition: isBugCondition(payment) = false (happy path)_
    - _Expected_Behavior: Proof row with status ACTIVE and correct credentialHash/commitment_
    - _Preservation: Preservation Requirements — does not touch MINIMUM_INCOME path_
    - _Requirements: 3.3, 4.2, 5.1_

  - [ ] 5.6 Sign credential, anchor, and return response
    - Call `this.signCredential(draftCredential)` to get signed credential
    - Call `this.contractAnchoringService?.anchorProof(...)` and conditionally update `contractTransactionHash`
    - Return `{ proofId, status, verificationUrl, credential: signedCredential, anchoring }`
    - _Requirements: 4.1, 4.3, 5.4_

- [ ] 6. Extend `verifyProof` with `PAYMENT_RECEIPT` branch

  - [ ] 6.1 Add `buildReceiptCredential` private helper in `src/proofs/proofs.service.ts`
    - Reads `proof.claim.disclosurePolicy` (typed as `Prisma.JsonValue`) and extracts `senderHidden`, `amountHidden`, `assetCode`, `assetIssuer`, `occurredAt`, `paymentReferenceHash`, optional `sourceAddress`, optional `amount`
    - Builds and returns a `PaymentReceiptCredential` matching the issuance shape
    - _Requirements: 5.5_

  - [ ] 6.2 Add `if (proof.proofType === ProofType.PAYMENT_RECEIPT)` branch inside `verifyProof`
    - Call `buildReceiptCredential(proof)` instead of `buildCredential(...)` for receipt proofs
    - The rest of the verification logic (hash check, status check, contract check, event write) is identical and unchanged
    - _Preservation: Preservation Requirements — `ELSE` branch keeps existing minimum-income path byte-for-byte unchanged_
    - _Requirements: 5.2, 5.5_

- [ ] 7. Add `POST /proofs/payment-receipt` controller route

  - [ ] 7.1 Import `CreatePaymentReceiptProofDto` in `src/proofs/proofs.controller.ts`
    - _Requirements: 6.1, 6.2, 6.3_

  - [ ] 7.2 Add `createPaymentReceiptProof` route method to `ProofsController`
    - Decorate with `@ApiBearerAuth()`, `@UseGuards(AuthGuard)`, `@Post('payment-receipt')`
    - Inject `@CurrentUser() user: AuthenticatedUser` and `@Body() body: CreatePaymentReceiptProofDto`
    - Delegate to `this.proofsService.createPaymentReceiptProof(user, body)`
    - No module changes needed — `ProofsModule` already provides all required services
    - _Requirements: 4.3, 6.1, 6.2, 6.3_

- [ ] 8. Write unit tests for `createPaymentReceiptProof`

  - [ ] 8.1 Verify bug condition exploration test now passes
    - **Property 1: Expected Behavior** - Issuance Guard Blocks Invalid Payments
    - **IMPORTANT**: Re-run the SAME tests from task 1 — do NOT write new tests
    - The tests from task 1 encode the expected guard behaviour
    - Run the guard tests in `proofs.service.spec.ts` after the implementation in tasks 3–7
    - **EXPECTED OUTCOME**: All five guard tests PASS (confirms bug is fixed / feature is implemented)
    - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.5_

  - [ ] 8.2 Add happy-path and disclosure unit tests in `src/proofs/proofs.service.spec.ts`
    - **Disclosure off (default)**: call without `discloseSender`/`discloseAmount` → credential contains neither `sourceAddress` nor `amount`; `privacy = { senderHidden: true, amountHidden: true }`
    - **Disclosure on**: `discloseSender: true, discloseAmount: true` → credential contains both; `privacy = { senderHidden: false, amountHidden: false }`
    - **Mixed disclosure**: `discloseSender: false, discloseAmount: true` → only `amount` present
    - **`paymentReferenceHash` one-way**: assert value equals `"sha256:" + sha256(payment.operationId)` and raw `operationId` does not appear in `JSON.stringify(result)`
    - **Credential hash integrity**: compute `sha256(canonicalize(credential_without_proof_field))` and assert it matches `result.credential.proof.credentialHash`
    - **Expiry default**: no `expiresInDays` → `expiresAt` within ±5 s of `now + 30 days`
    - **Expiry custom**: `expiresInDays: 7` → `expiresAt` within ±5 s of `now + 7 days`
    - **Anchoring propagation**: `anchorProof` returns `{ anchored: true, transactionHash: 'tx_1' }` → `result.anchoring.transactionHash = 'tx_1'` and `prisma.proof.update` called with `{ contractTransactionHash: 'tx_1' }`
    - **Anchoring disabled**: no `ContractAnchoringService` → `result.anchoring = { anchored: false, reason: 'disabled' }`
    - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.5, 2.6, 2.7, 4.2, 5.1, 5.4_

- [ ] 9. Add lifecycle and round-trip property tests

  - [ ] 9.1 Verify preservation tests still pass
    - **Property 2: Preservation** - Minimum-Income Path Is Completely Unaffected
    - **IMPORTANT**: Re-run the SAME tests from task 2 — do NOT write new tests
    - Run `npm test -- --testPathPattern=proofs.service.spec --runInBand` and `npm test -- --testPathPattern=proofs.lifecycle.spec --runInBand`
    - **EXPECTED OUTCOME**: All pre-existing tests PASS (confirms no regressions)
    - _Requirements: 5.2, 5.3, 5.4_

  - [ ] 9.2 Add receipt proof lifecycle test in `src/proofs/proofs.lifecycle.spec.ts`
    - New `describe` block: `PAYMENT_RECEIPT lifecycle`
    - State transitions: create → `ACTIVE`; verify → `VALID`; revoke → `REVOKED`; re-verify → `REVOKED`
    - Mirrors the existing minimum-income lifecycle test structure exactly
    - _Requirements: 5.2, 5.3_

  - [ ] 9.3 Add disclosure consistency round-trip tests in `src/proofs/proofs.lifecycle.spec.ts`
    - For all four combinations of `{ discloseSender, discloseAmount }`: create proof, call `verifyProof`, assert `result.result = VALID` and the reconstructed credential contains exactly the same `sourceAddress`/`amount` presence as the issuance response
    - _Requirements: 5.5_

- [ ] 10. Checkpoint — Ensure all tests pass and project builds
  - Run `npm run lint` — fix any linting errors before proceeding
  - Run `npm test -- --runInBand` — all tests must pass
  - Run `npm run build` — TypeScript compilation must succeed with no errors
  - Confirm no regressions in minimum-income, revocation, or verification tests
  - Ensure all tests pass; ask the user if questions arise
