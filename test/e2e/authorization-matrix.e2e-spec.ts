import { ApiKeyScope, ResourceStatus, UserRole } from "@prisma/client";
import * as request from "supertest";
import { ApiKeyService } from "../../src/api-keys/api-key.service";
import { integrationDatabase } from "../integration/harness/database";
import { seedOrganization } from "../integration/harness/fixtures";
import { e2eApp } from "./harness/app";
import { authenticateNewWallet } from "./harness/wallet-auth";

const db = integrationDatabase();
const e2e = e2eApp();

describe("authorization and tenant-isolation matrix", () => {
  it("denies anonymous access to every representative bearer route", async () => {
    for (const path of ["/api/v1/auth/session", "/api/v1/organizations", "/api/v1/proofs", "/api/v1/webhooks"]) {
      await request(e2e.httpServer).get(path).expect(401);
    }
  });

  it("enforces live suspended and deleted account status", async () => {
    const client = await authenticateNewWallet(e2e.httpServer);
    for (const status of [ResourceStatus.SUSPENDED, ResourceStatus.DELETED]) {
      await db.prisma.user.update({ where: { id: client.userId }, data: { status } });
      await request(e2e.httpServer).get("/api/v1/auth/session").set("Authorization", `Bearer ${client.token}`).expect(401);
    }
  });

  it("enforces admin role independently of a valid bearer session", async () => {
    const client = await authenticateNewWallet(e2e.httpServer);
    await db.prisma.user.update({ where: { id: client.userId }, data: { role: UserRole.DEVELOPER } });
    await request(e2e.httpServer)
      .post("/api/v1/organizations")
      .set("Authorization", `Bearer ${client.token}`)
      .send({ name: "Synthetic organization", slug: "synthetic-organization" })
      .expect(403);
  });

  it("returns the same denial for another tenant's organization and an absent one", async () => {
    const owner = await authenticateNewWallet(e2e.httpServer);
    const other = await authenticateNewWallet(e2e.httpServer);
    const organization = await seedOrganization(db.prisma, "tenant-owner", owner.userId);
    const denied = await request(e2e.httpServer).get(`/api/v1/organizations/${organization.id}`).set("Authorization", `Bearer ${other.token}`).expect(404);
    const absent = await request(e2e.httpServer).get("/api/v1/organizations/org_does_not_exist").set("Authorization", `Bearer ${other.token}`).expect(404);
    expect(denied.body.message).toBe(absent.body.message);
    expect(JSON.stringify(denied.body)).not.toContain(organization.name);
  });

  it("enforces API-key scope and organization independently from bearer sessions", async () => {
    const owner = await authenticateNewWallet(e2e.httpServer);
    const organization = await seedOrganization(db.prisma, "api-key-org", owner.userId);
    const apiKeys = e2e.app.get(ApiKeyService);
    const insufficient = await apiKeys.createKey({ organizationId: organization.id, createdBy: owner.userId, name: "synthetic-empty-scope", scopes: [] });
    const allowed = await apiKeys.createKey({ organizationId: organization.id, createdBy: owner.userId, name: "synthetic-read-scope", scopes: [ApiKeyScope.ORG_READ] });
    const endpoint = "/api/v1/integrations/auth-context";
    await request(e2e.httpServer).get(endpoint).set("Authorization", `Bearer ${insufficient.secret}`).set("X-Organization-Id", organization.id).expect(403);
    await request(e2e.httpServer).get(endpoint).set("Authorization", `Bearer ${allowed.secret}`).set("X-Organization-Id", organization.id).expect(200);
    await request(e2e.httpServer).get(endpoint).set("Authorization", `Bearer ${allowed.secret}`).set("X-Organization-Id", "other-organization").expect(401);
  });
});
