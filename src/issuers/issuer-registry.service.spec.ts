import { ResourceStatus } from "@prisma/client";
import { IssuerRegistryService } from "./issuer-registry.service";

describe("IssuerRegistryService", () => {
  const input = {
    issuerId: "issuer_1",
    stellarAddress: "GBFXVVSIVZHCSLMZ23N7QDOSFKMCXFQZ7S3KBXCGYZTZZBDSJ2SPCZYZ",
    metadataHash: "a".repeat(64),
    status: ResourceStatus.ACTIVE,
    contractSyncedStatus: null,
  };

  it("reports PENDING before an issuer is approved", async () => {
    const service = new IssuerRegistryService({
      get: jest.fn(),
    } as never);

    await expect(
      service.sync({ ...input, status: ResourceStatus.PENDING }),
    ).resolves.toEqual({
      state: "pending",
      reason: "Issuer must be ACTIVE before contract registration",
    });
  });

  it("reports DISABLED when the registry is not fully configured", async () => {
    const service = new IssuerRegistryService({
      get: jest.fn(),
    } as never);

    await expect(service.sync(input)).resolves.toEqual({
      state: "disabled",
      reason: "Issuer registry synchronization is not configured",
    });
  });
});
