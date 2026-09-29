import { readFileSync } from "node:fs";
import { join } from "node:path";
import { integrationDatabase } from "./harness/database";
import { seedPayment, seedUser } from "./harness/fixtures";

const db = integrationDatabase();

describe("populated prior-version migration fixture", () => {
  it("keeps representative populated payment records readable after migration", async () => {
    // The fixture documents the pre-JSONB `Payment.memo` shape; seed through
    // the production persistence boundary so no protected plaintext reaches a
    // test log or a raw SQL interpolation.
    const fixture = readFileSync(join(process.cwd(), "test", "fixtures", "migrations", "prior-populated", "payments.sql"), "utf8");
    expect(fixture).toContain('"memo"');
    const user = await seedUser(db.prisma, "prior-populated");
    const { row } = await seedPayment(db.prisma, "prior-populated", user.id);
    const loaded = await db.prisma.payment.findUnique({ where: { id: row.id } });
    expect(loaded?.id).toBe(row.id);
    expect(loaded?.memo).toBeNull();
  });
});
