import { ConfigService } from "@nestjs/config";
import { StellarService } from "./stellar.service";

describe("StellarService", () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it("normalizes incoming native payments", async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      // The Horizon transport classifies by status code, so a stub standing in
      // for a Response has to carry one.
      status: 200,
      json: async () => ({
        _embedded: {
          records: [
            {
              id: "123",
              type: "payment",
              transaction_hash: "tx",
              created_at: "2026-07-13T00:00:00Z",
              from: "GA",
              to: "GB",
              asset_type: "native",
              amount: "10.0000000",
            },
            {
              id: "124",
              type: "payment",
              transaction_hash: "tx2",
              created_at: "2026-07-13T00:00:00Z",
              from: "GB",
              to: "GA",
              asset_type: "native",
              amount: "5.0000000",
            },
          ],
        },
      }),
    }) as never;

    const service = new StellarService({
      getOrThrow: () => "https://horizon-testnet.stellar.org",
    } as unknown as ConfigService);

    await expect(service.fetchIncomingPayments("GB")).resolves.toEqual([
      expect.objectContaining({
        operationId: "123",
        sourceAddress: "GA",
        destinationAddress: "GB",
        assetCode: "XLM",
        assetIssuer: null,
        amount: "10.0000000",
      }),
    ]);
  });

  it("fetches a transaction record by encoded hash", async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ hash: "tx/hash", memo_type: "id", memo: "42" }),
    }) as never;
    const service = new StellarService({
      getOrThrow: () => "https://horizon-testnet.stellar.org",
    } as unknown as ConfigService);

    await expect(service.fetchTransaction("tx/hash")).resolves.toMatchObject({
      memo_type: "id",
      memo: "42",
    });
    expect(global.fetch).toHaveBeenCalledWith(
      "https://horizon-testnet.stellar.org/transactions/tx%2Fhash",
    );
  });

  it("rejects non-successful transaction responses", async () => {
    global.fetch = jest.fn().mockResolvedValue({ ok: false, status: 503 }) as never;
    const service = new StellarService({
      getOrThrow: () => "https://horizon-testnet.stellar.org",
    } as unknown as ConfigService);

    await expect(service.fetchTransaction("tx")).rejects.toThrow(
      "Stellar Horizon is temporarily unavailable",
    );
  });

  it.each([
    ["a non-success response", { ok: false, status: 503 }],
    ["a network failure", new TypeError("fetch failed")],
  ])("maps %s to a safe dependency error", async (_label, result) => {
    global.fetch =
      result instanceof Error
        ? (jest.fn().mockRejectedValue(result) as never)
        : (jest.fn().mockResolvedValue(result) as never);
    const service = new StellarService({
      getOrThrow: () => "https://horizon-testnet.stellar.org",
    } as unknown as ConfigService);

    await expect(service.fetchIncomingPayments("GB")).rejects.toMatchObject({
      status: 503,
    });
  });
});
