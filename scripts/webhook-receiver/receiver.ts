/**
 * Runnable reference webhook receiver.
 *
 * A correct receiver is mostly about what it does *not* do: it does not parse
 * the body before verifying it, does not compare signatures with `===`, does
 * not trust the timestamp, and does not log the things that would turn its own
 * log file into the breach. This file is small enough to read in one sitting
 * for that reason.
 *
 * Run it standalone:
 *
 *     npm run webhook:receiver -- --secret <endpoint-secret>
 *
 * It binds to 127.0.0.1 on an ephemeral port unless told otherwise, so starting
 * it cannot accidentally expose an endpoint to a network.
 */
import { createServer, IncomingMessage, Server, ServerResponse } from "node:http";
import { AddressInfo } from "node:net";
import {
  DeliveryIdStore,
  HEADERS,
  VerificationFailureReason,
  verifyWebhookSignature,
} from "./verifier";

/** Refuse a body larger than this outright. */
const DEFAULT_MAX_BODY_BYTES = 1024 * 1024;

/** Path the receiver listens on. */
const WEBHOOK_PATH = "/webhooks/earnproof";

export type ReceiverOutcome = "accepted" | "duplicate" | VerificationFailureReason;

export interface ReceiverOptions {
  /** Every secret currently valid. More than one only during a rotation. */
  secrets: readonly string[];
  toleranceSeconds?: number;
  maxBodyBytes?: number;
  /** Injected clock in whole seconds, so conformance runs are not time-dependent. */
  now?: () => number;
  /** Delivery-ID store. Supply one to share it across restarts in a real deployment. */
  deliveries?: DeliveryIdStore;
  /**
   * Called once per accepted, non-duplicate delivery.
   *
   * Receives the raw bytes: what the integrator does with them is their
   * business, but it happens strictly after verification.
   */
  onDelivery?: (delivery: {
    deliveryId: string;
    eventType: string | undefined;
    rawBody: Buffer;
  }) => void;
  /** Sink for the receiver's own log lines. See `safeLogLine` for what may go in one. */
  log?: (line: string) => void;
}

export interface RunningReceiver {
  server: Server;
  port: number;
  url: string;
  close: () => Promise<void>;
}

/**
 * Maps an outcome to a status code.
 *
 * A duplicate is a success. The delivery was received and there is nothing more
 * for the sender to do; answering 4xx would make the sender retry an event the
 * receiver has already processed, five times, for nothing.
 *
 * A signature failure is 401 rather than 400 to separate "I do not believe you
 * sent this" from "this request is malformed", which is the distinction an
 * operator needs when reading the sender's delivery log.
 */
export function statusForOutcome(outcome: ReceiverOutcome): number {
  switch (outcome) {
    case "accepted":
      return 204;
    case "duplicate":
      return 200;
    case "signature_mismatch":
      return 401;
    default:
      return 400;
  }
}

/**
 * The only fields that may appear in a receiver log line.
 *
 * Not the signature, not the timestamp header, not any request header, and
 * above all not the body. A webhook body carries proof identifiers and
 * credential hashes; a log that retains them turns log access into data access.
 * The delivery ID is included because it is an opaque identifier with no
 * meaning outside the sender's delivery table, and support is impossible
 * without it.
 */
function safeLogLine(outcome: ReceiverOutcome, status: number, deliveryId: string | undefined): string {
  const subject = deliveryId ? ` delivery=${deliveryId}` : "";
  return `POST ${WEBHOOK_PATH} -> ${status} ${outcome}${subject}`;
}

/** Collects the raw request body, refusing anything over the cap. */
function readRawBody(request: IncomingMessage, maxBytes: number): Promise<Buffer | null> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let total = 0;

    request.on("data", (chunk: Buffer) => {
      total += chunk.length;
      if (total > maxBytes) {
        // Stop reading rather than buffering an attacker-chosen amount.
        request.destroy();
        resolve(null);
        return;
      }
      chunks.push(chunk);
    });

    request.on("end", () => resolve(Buffer.concat(chunks)));
    request.on("error", () => resolve(null));
  });
}

function header(request: IncomingMessage, name: string): string | undefined {
  const value = request.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

function respond(
  response: ServerResponse,
  status: number,
  payload: Record<string, unknown>,
): void {
  // 204 carries no body, and sending Content-Length with it is a protocol
  // violation that some clients treat as a framing error.
  if (status === 204) {
    response.writeHead(204);
    response.end();
    return;
  }

  const body = JSON.stringify(payload);
  response.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(body),
  });
  response.end(body);
}

export function createReceiver(options: ReceiverOptions): Server {
  const tolerance = options.toleranceSeconds;
  const maxBodyBytes = options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
  const now = options.now ?? (() => Math.floor(Date.now() / 1000));
  const deliveries = options.deliveries ?? new DeliveryIdStore();
  const log = options.log ?? (() => undefined);

  return createServer(async (request, response) => {
    if (request.method !== "POST") {
      respond(response, 405, { status: "rejected", reason: "method_not_allowed" });
      return;
    }

    const path = (request.url ?? "").split("?")[0];
    if (path !== WEBHOOK_PATH) {
      respond(response, 404, { status: "rejected", reason: "not_found" });
      return;
    }

    const rawBody = await readRawBody(request, maxBodyBytes);
    if (rawBody === null) {
      if (!response.writableEnded) {
        respond(response, 413, { status: "rejected", reason: "body_too_large" });
      }
      return;
    }

    const deliveryIdHeader = header(request, HEADERS.delivery);

    const verification = verifyWebhookSignature({
      secrets: options.secrets,
      rawBody,
      signatureHeader: header(request, HEADERS.signature),
      timestampHeader: header(request, HEADERS.timestamp),
      deliveryIdHeader,
      nowSeconds: now(),
      toleranceSeconds: tolerance,
    });

    if (!verification.ok) {
      const status = statusForOutcome(verification.reason);
      log(safeLogLine(verification.reason, status, deliveryIdHeader));
      respond(response, status, { status: "rejected", reason: verification.reason });
      return;
    }

    // Only now, with the signature verified, is the delivery ID allowed to
    // reserve a slot. Registering any earlier would let an unauthenticated
    // caller suppress a genuine delivery by claiming its ID first.
    const isNew = deliveries.register(verification.deliveryId, now());

    if (!isNew) {
      log(safeLogLine("duplicate", 200, verification.deliveryId));
      respond(response, 200, { status: "duplicate", deliveryId: verification.deliveryId });
      return;
    }

    options.onDelivery?.({
      deliveryId: verification.deliveryId,
      eventType: header(request, HEADERS.event),
      rawBody,
    });

    log(safeLogLine("accepted", 204, verification.deliveryId));
    respond(response, 204, {});
  });
}

/** Starts a receiver and resolves once it is accepting connections. */
export function startReceiver(
  options: ReceiverOptions,
  port = 0,
  host = "127.0.0.1",
): Promise<RunningReceiver> {
  const server = createReceiver(options);

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      const address = server.address() as AddressInfo;
      resolve({
        server,
        port: address.port,
        url: `http://${host}:${address.port}${WEBHOOK_PATH}`,
        close: () =>
          new Promise<void>((done) => {
            server.close(() => done());
          }),
      });
    });
  });
}

export { WEBHOOK_PATH };

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function parseSecrets(argv: string[]): string[] {
  const secrets: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--secret" && argv[index + 1]) {
      secrets.push(argv[index + 1]);
      index += 1;
    }
  }
  // Reading from the environment keeps the secret out of the process list,
  // where `--secret` would otherwise leave it for any local user to read.
  const fromEnv = process.env.EARNPROOF_WEBHOOK_SECRET;
  if (fromEnv) secrets.push(fromEnv);
  return secrets;
}

async function main(): Promise<void> {
  const secrets = parseSecrets(process.argv.slice(2));

  if (secrets.length === 0) {
    console.error(
      "No secret supplied. Set EARNPROOF_WEBHOOK_SECRET (preferred: it stays out of the process list) " +
        "or pass --secret <value>.",
    );
    process.exit(1);
  }

  const port = Number(process.env.PORT ?? 0);
  const running = await startReceiver({
    secrets,
    log: (line) => console.log(line),
  }, port);

  console.log(`Listening on ${running.url}`);
  console.log(`Accepting ${secrets.length} secret(s). Press Ctrl+C to stop.`);
}

if (require.main === module) {
  main().catch((error: unknown) => {
    // The error `code` (EADDRINUSE, EACCES) is what an operator needs and is
    // never sensitive. The message is not printed: a startup failure can carry
    // the configuration it choked on.
    const code =
      typeof error === "object" && error !== null && "code" in error
        ? String((error as { code: unknown }).code)
        : undefined;
    console.error(
      `Receiver failed to start${code ? `: ${code}` : ""}. ` +
        `Check that the port is free and that a secret is configured.`,
    );
    process.exit(1);
  });
}
