/**
 * Webhook signing conformance runner.
 *
 * Drives every golden vector through two layers:
 *
 *  1. the reference verifier, in-process — proves the signing rules
 *  2. the reference receiver, over a real TCP socket — proves the *plumbing*
 *
 * The second layer is the one that earns its keep. Almost every real-world
 * webhook verification bug is not a mistake in the HMAC; it is a framework
 * quietly parsing and re-serialising the body before the handler sees it, so
 * the bytes that get verified are not the bytes that were signed. That failure
 * is invisible to a unit test that hands the verifier a string, and unmissable
 * once the request has been through an HTTP server.
 *
 * Exported as a function so the Jest suite and the CLI run identical checks —
 * a conformance kit that CI runs differently from the way it is documented is
 * two kits, and one of them is untested.
 *
 * Run: npm run webhook:conformance
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  DeliveryIdStore,
  VerificationFailureReason,
  verifyWebhookSignature,
} from "./verifier";
import { HEADERS } from "./verifier";
import { startReceiver, RunningReceiver } from "./receiver";

const VECTORS_RELATIVE_PATH = join(
  "test",
  "fixtures",
  "webhooks",
  "signing-vectors.json",
);

/**
 * Locates the vector file by walking up from this module.
 *
 * Not a fixed `../../` hop: this file runs from source under ts-node and from
 * `dist/` after a build, and those sit at different depths. A hard-coded
 * relative path works in whichever one it was written for and fails silently in
 * the other, which is a poor way to discover that the conformance kit cannot
 * find its own vectors.
 */
function resolveVectorsPath(): string {
  let directory = __dirname;

  for (let depth = 0; depth < 8; depth += 1) {
    const candidate = join(directory, VECTORS_RELATIVE_PATH);
    if (existsSync(candidate)) return candidate;

    const parent = dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }

  throw new Error(
    `Could not locate ${VECTORS_RELATIVE_PATH} above ${__dirname}. ` +
      "The conformance kit must be run from within the repository.",
  );
}

// ---------------------------------------------------------------------------
// Vector file shape
// ---------------------------------------------------------------------------

export interface PositiveVector {
  id: string;
  description: string;
  secret: string;
  secretBase64: string;
  timestamp: number;
  deliveryId: string;
  eventType: string;
  body: string;
  bodyBase64: string;
  bodyByteLength: number;
  signingBase: string;
  signingBaseBase64: string;
  expectedSignature: string;
  verifyAtSeconds: number;
}

export interface NegativeVector {
  id: string;
  description: string;
  derivedFrom: string;
  secret: string;
  headerTimestamp: string | null;
  headerDeliveryId: string | null;
  headerSignature: string | null;
  body: string;
  bodyBase64: string;
  verifyAtSeconds: number;
  expectedFailure: VerificationFailureReason;
}

export interface ReplayStep {
  vectorId?: string;
  negativeVectorId?: string;
  expect: string;
}

export interface ReplayScenario {
  id: string;
  description: string;
  steps: ReplayStep[];
}

export interface RotationScenario {
  id: string;
  description: string;
  secrets: string[];
  vectorId: string;
  expect: string;
}

export interface VectorFile {
  schemeVersion: string;
  algorithm: string;
  referenceNowSeconds: number;
  toleranceSeconds: number;
  positive: PositiveVector[];
  negative: NegativeVector[];
  replayScenarios: ReplayScenario[];
  rotationScenarios: RotationScenario[];
}

export function loadVectors(): VectorFile {
  return JSON.parse(readFileSync(resolveVectorsPath(), "utf8")) as VectorFile;
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

export interface ConformanceFailure {
  check: string;
  detail: string;
}

export interface ConformanceReport {
  passed: number;
  failures: ConformanceFailure[];
}

class Recorder {
  readonly failures: ConformanceFailure[] = [];
  passed = 0;

  expect(condition: boolean, check: string, detail: string): void {
    if (condition) {
      this.passed += 1;
      return;
    }
    this.failures.push({ check, detail });
  }
}

// ---------------------------------------------------------------------------
// Checks
// ---------------------------------------------------------------------------

/**
 * The vector file must be internally consistent before anything is inferred
 * from it. A golden file that disagrees with itself would let a broken
 * implementation pass by matching the wrong field.
 */
function checkVectorIntegrity(vectors: VectorFile, record: Recorder): void {
  for (const vector of vectors.positive) {
    record.expect(
      Buffer.from(vector.bodyBase64, "base64").toString("utf8") === vector.body,
      `integrity:${vector.id}:body-base64`,
      "bodyBase64 does not decode to body",
    );
    record.expect(
      Buffer.byteLength(vector.body, "utf8") === vector.bodyByteLength,
      `integrity:${vector.id}:body-length`,
      "bodyByteLength disagrees with the body",
    );
    record.expect(
      vector.signingBase === `${vector.timestamp}.${vector.deliveryId}.${vector.body}`,
      `integrity:${vector.id}:signing-base`,
      "signingBase is not timestamp + '.' + deliveryId + '.' + body",
    );
    record.expect(
      /^v1=[0-9a-f]{64}$/.test(vector.expectedSignature),
      `integrity:${vector.id}:signature-shape`,
      "expectedSignature is not v1= followed by 64 lowercase hex characters",
    );
    // The vectors are published. A secret that looked real would be treated as
    // a leak by anyone who found it, and would have to be handled as an
    // incident before anyone could confirm it was not.
    record.expect(
      /synthetic|deadbeef/i.test(vector.secret),
      `integrity:${vector.id}:synthetic-secret`,
      "secret is not recognisably synthetic",
    );
  }
}

/** Every positive vector must verify; every negative must fail for its stated reason. */
function checkOffline(vectors: VectorFile, record: Recorder): void {
  for (const vector of vectors.positive) {
    const result = verifyWebhookSignature({
      secrets: [vector.secret],
      rawBody: Buffer.from(vector.bodyBase64, "base64"),
      signatureHeader: vector.expectedSignature,
      timestampHeader: String(vector.timestamp),
      deliveryIdHeader: vector.deliveryId,
      nowSeconds: vector.verifyAtSeconds,
      toleranceSeconds: vectors.toleranceSeconds,
    });

    record.expect(
      result.ok,
      `offline-positive:${vector.id}`,
      result.ok ? "" : `expected acceptance, got ${result.reason}`,
    );
  }

  for (const vector of vectors.negative) {
    const result = verifyWebhookSignature({
      secrets: [vector.secret],
      rawBody: Buffer.from(vector.bodyBase64, "base64"),
      signatureHeader: vector.headerSignature,
      timestampHeader: vector.headerTimestamp,
      deliveryIdHeader: vector.headerDeliveryId,
      nowSeconds: vector.verifyAtSeconds,
      toleranceSeconds: vectors.toleranceSeconds,
    });

    record.expect(
      !result.ok && result.reason === vector.expectedFailure,
      `offline-negative:${vector.id}`,
      result.ok
        ? `expected ${vector.expectedFailure}, but the signature was accepted`
        : `expected ${vector.expectedFailure}, got ${(result as { reason: string }).reason}`,
    );
  }
}

/** Deduplication, replay, and the cache-poisoning ordering rule. */
function checkReplayScenarios(vectors: VectorFile, record: Recorder): void {
  const positives = new Map(vectors.positive.map((v) => [v.id, v]));
  const negatives = new Map(vectors.negative.map((v) => [v.id, v]));

  for (const scenario of vectors.replayScenarios) {
    const store = new DeliveryIdStore();

    for (const [index, step] of scenario.steps.entries()) {
      const label = `replay:${scenario.id}:step-${index}`;
      let outcome: string;

      if (step.vectorId) {
        const vector = positives.get(step.vectorId);
        if (!vector) {
          record.expect(false, label, `unknown positive vector ${step.vectorId}`);
          continue;
        }
        const result = verifyWebhookSignature({
          secrets: [vector.secret],
          rawBody: Buffer.from(vector.bodyBase64, "base64"),
          signatureHeader: vector.expectedSignature,
          timestampHeader: String(vector.timestamp),
          deliveryIdHeader: vector.deliveryId,
          nowSeconds: vector.verifyAtSeconds,
          toleranceSeconds: vectors.toleranceSeconds,
        });
        outcome = result.ok
          ? store.register(result.deliveryId, vector.verifyAtSeconds)
            ? "accepted"
            : "duplicate_delivery"
          : result.reason;
      } else {
        const vector = negatives.get(step.negativeVectorId as string);
        if (!vector) {
          record.expect(false, label, `unknown negative vector ${step.negativeVectorId}`);
          continue;
        }
        const result = verifyWebhookSignature({
          secrets: [vector.secret],
          rawBody: Buffer.from(vector.bodyBase64, "base64"),
          signatureHeader: vector.headerSignature,
          timestampHeader: vector.headerTimestamp,
          deliveryIdHeader: vector.headerDeliveryId,
          nowSeconds: vector.verifyAtSeconds,
          toleranceSeconds: vectors.toleranceSeconds,
        });
        // A failed verification must never touch the store — that is the whole
        // point of the poisoning scenario.
        outcome = result.ok ? "accepted" : result.reason;
      }

      record.expect(outcome === step.expect, label, `expected ${step.expect}, got ${outcome}`);
    }
  }
}

/** Rotation: both secrets accepted during the overlap, old one refused after. */
function checkRotationScenarios(vectors: VectorFile, record: Recorder): void {
  const positives = new Map(vectors.positive.map((v) => [v.id, v]));

  for (const scenario of vectors.rotationScenarios) {
    const vector = positives.get(scenario.vectorId);
    if (!vector) {
      record.expect(false, `rotation:${scenario.id}`, `unknown vector ${scenario.vectorId}`);
      continue;
    }

    const result = verifyWebhookSignature({
      secrets: scenario.secrets,
      rawBody: Buffer.from(vector.bodyBase64, "base64"),
      signatureHeader: vector.expectedSignature,
      timestampHeader: String(vector.timestamp),
      deliveryIdHeader: vector.deliveryId,
      nowSeconds: vector.verifyAtSeconds,
      toleranceSeconds: vectors.toleranceSeconds,
    });

    const outcome = result.ok ? "accepted" : result.reason;
    record.expect(
      outcome === scenario.expect,
      `rotation:${scenario.id}`,
      `expected ${scenario.expect}, got ${outcome}`,
    );
  }
}

// ---------------------------------------------------------------------------
// Over the wire
// ---------------------------------------------------------------------------

interface HttpOutcome {
  status: number;
  reason?: string;
}

async function post(
  url: string,
  vector: {
    bodyBase64: string;
    headerSignature: string | null;
    headerTimestamp: string | null;
    headerDeliveryId: string | null;
    eventType?: string;
  },
): Promise<HttpOutcome> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (vector.headerSignature !== null) headers[HEADERS.signature] = vector.headerSignature;
  if (vector.headerTimestamp !== null) headers[HEADERS.timestamp] = vector.headerTimestamp;
  if (vector.headerDeliveryId !== null) headers[HEADERS.delivery] = vector.headerDeliveryId;
  if (vector.eventType) headers[HEADERS.event] = vector.eventType;

  const response = await fetch(url, {
    method: "POST",
    headers,
    body: Buffer.from(vector.bodyBase64, "base64"),
  });

  if (response.status === 204) return { status: 204 };

  const text = await response.text();
  try {
    const parsed = JSON.parse(text) as { reason?: string; status?: string };
    return { status: response.status, reason: parsed.reason ?? parsed.status };
  } catch {
    return { status: response.status };
  }
}

/**
 * Runs every vector through a real HTTP round trip.
 *
 * The receiver's clock is pinned per request because the vectors carry fixed
 * timestamps: without this, every vector would age out of the tolerance window
 * the day after it was written, and the suite would start failing for a reason
 * that has nothing to do with the protocol.
 */
async function checkOverHttp(vectors: VectorFile, record: Recorder): Promise<void> {
  let clock = vectors.referenceNowSeconds;

  const secrets = [
    ...new Set([
      ...vectors.positive.map((v) => v.secret),
      ...vectors.negative.map((v) => v.secret),
    ]),
  ];

  let running: RunningReceiver | undefined;

  try {
    running = await startReceiver({
      secrets,
      toleranceSeconds: vectors.toleranceSeconds,
      now: () => clock,
      // The conformance run must not print anything derived from a request.
      log: () => undefined,
      maxBodyBytes: 1024 * 1024,
    });

    for (const vector of vectors.positive) {
      clock = vector.verifyAtSeconds;
      const outcome = await post(running.url, {
        bodyBase64: vector.bodyBase64,
        headerSignature: vector.expectedSignature,
        headerTimestamp: String(vector.timestamp),
        headerDeliveryId: vector.deliveryId,
        eventType: vector.eventType,
      });

      record.expect(
        outcome.status === 204,
        `http-positive:${vector.id}`,
        `expected 204, got ${outcome.status}${outcome.reason ? ` (${outcome.reason})` : ""}`,
      );
    }

    for (const vector of vectors.negative) {
      clock = vector.verifyAtSeconds;
      const outcome = await post(running.url, {
        bodyBase64: vector.bodyBase64,
        headerSignature: vector.headerSignature,
        headerTimestamp: vector.headerTimestamp,
        headerDeliveryId: vector.headerDeliveryId,
      });

      const expectedStatus = vector.expectedFailure === "signature_mismatch" ? 401 : 400;
      record.expect(
        outcome.status === expectedStatus && outcome.reason === vector.expectedFailure,
        `http-negative:${vector.id}`,
        `expected ${expectedStatus}/${vector.expectedFailure}, got ${outcome.status}/${outcome.reason}`,
      );
    }

  } finally {
    if (running) await running.close();
  }
}

/**
 * Deduplication over the wire.
 *
 * Deliberately on its own receiver with a stationary clock. The vector sweep
 * above advances the pinned clock to each vector's own instant — including one
 * vector dated past 2038 — and a jump of that size ages every previously seen
 * delivery ID out of the retention window. Sharing that receiver would make
 * this check depend on vector ordering rather than on deduplication.
 */
async function checkDuplicateOverHttp(
  vectors: VectorFile,
  record: Recorder,
): Promise<void> {
  const vector = vectors.positive[0];
  const running = await startReceiver({
    secrets: [vector.secret],
    toleranceSeconds: vectors.toleranceSeconds,
    now: () => vector.verifyAtSeconds,
    log: () => undefined,
  });

  const request = {
    bodyBase64: vector.bodyBase64,
    headerSignature: vector.expectedSignature,
    headerTimestamp: String(vector.timestamp),
    headerDeliveryId: vector.deliveryId,
    eventType: vector.eventType,
  };

  try {
    const first = await post(running.url, request);
    record.expect(
      first.status === 204,
      "http-replay:first-delivery-accepted",
      `expected 204 on first delivery, got ${first.status}/${first.reason}`,
    );

    const repeat = await post(running.url, request);
    record.expect(
      repeat.status === 200 && repeat.reason === "duplicate",
      "http-replay:duplicate-delivery-id",
      `expected 200/duplicate on the second delivery, got ${repeat.status}/${repeat.reason}`,
    );

    // A duplicate must still be a 2xx: answering 4xx makes the sender retry an
    // event that has already been processed, for its full retry schedule.
    record.expect(
      repeat.status >= 200 && repeat.status < 300,
      "http-replay:duplicate-is-success",
      `a duplicate must not provoke a retry; got ${repeat.status}`,
    );
  } finally {
    await running.close();
  }
}

/**
 * Proves the receiver verifies the bytes it received rather than a
 * re-serialisation of them.
 *
 * Sent as raw bytes with the JSON keys in a different order from the signed
 * body. A receiver that parses first and re-encodes would produce the signed
 * ordering again and wrongly accept.
 */
async function checkRawBodyPreservation(vectors: VectorFile, record: Recorder): Promise<void> {
  const pretty = vectors.positive.find((v) => v.id === "pretty-printed-body");
  const reordered = vectors.negative.find((v) => v.id === "tampered-body-reordered-keys");

  if (!pretty || !reordered) {
    record.expect(false, "raw-body:vectors-present", "raw-body vectors are missing");
    return;
  }

  let clock = pretty.verifyAtSeconds;
  const running = await startReceiver({
    secrets: [pretty.secret, reordered.secret],
    toleranceSeconds: vectors.toleranceSeconds,
    now: () => clock,
    log: () => undefined,
  });

  try {
    const indented = await post(running.url, {
      bodyBase64: pretty.bodyBase64,
      headerSignature: pretty.expectedSignature,
      headerTimestamp: String(pretty.timestamp),
      headerDeliveryId: pretty.deliveryId,
      eventType: pretty.eventType,
    });
    record.expect(
      indented.status === 204,
      "raw-body:indented-json-accepted",
      `whitespace-significant body should verify unchanged, got ${indented.status}`,
    );

    clock = reordered.verifyAtSeconds;
    const shuffled = await post(running.url, {
      bodyBase64: reordered.bodyBase64,
      headerSignature: reordered.headerSignature,
      headerTimestamp: reordered.headerTimestamp,
      headerDeliveryId: reordered.headerDeliveryId,
    });
    record.expect(
      shuffled.status === 401,
      "raw-body:reordered-json-rejected",
      `re-serialising the body before verifying would accept this; got ${shuffled.status}`,
    );
  } finally {
    await running.close();
  }
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export async function runConformance(): Promise<ConformanceReport> {
  const vectors = loadVectors();
  const record = new Recorder();

  checkVectorIntegrity(vectors, record);
  checkOffline(vectors, record);
  checkReplayScenarios(vectors, record);
  checkRotationScenarios(vectors, record);
  await checkOverHttp(vectors, record);
  await checkDuplicateOverHttp(vectors, record);
  await checkRawBodyPreservation(vectors, record);

  return { passed: record.passed, failures: record.failures };
}

async function main(): Promise<void> {
  const report = await runConformance();

  for (const failure of report.failures) {
    console.error(`FAIL ${failure.check}: ${failure.detail}`);
  }

  if (report.failures.length > 0) {
    console.error(
      `\nWebhook conformance FAILED: ${report.failures.length} of ${
        report.passed + report.failures.length
      } checks did not pass.`,
    );
    process.exit(1);
  }

  console.log(`Webhook conformance PASSED: ${report.passed} checks.`);
}

if (require.main === module) {
  main().catch((error: unknown) => {
    console.error(
      `Conformance run aborted: ${error instanceof Error ? error.message : "unknown error"}`,
    );
    process.exit(1);
  });
}
