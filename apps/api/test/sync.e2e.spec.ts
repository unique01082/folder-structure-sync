import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import request from "supertest";
import { Logger } from "@nestjs/common";
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";

import { createTestApplication, type TestApplication } from "../src/testing.js";

const ISSUER = "https://auth.baole.space/application/o/rootline/";
const AUDIENCE = "rootline-desktop";
const EPOCH = "00000000-0000-4000-8000-000000000001";
const PROFILE_ID = "profile-existing-task3";
const execFileAsync = promisify(execFile);

describe("Rootline hosted sync (real PostgreSQL)", () => {
  let fixture: TestApplication;
  let directory: string;
  let privateKey: CryptoKey;
  let apiUrl: string;
  let postgres: PrismaClient;

  beforeAll(async () => {
    if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL must point to a real PostgreSQL test database");
    directory = await mkdtemp(join(tmpdir(), "rootline-jwks-"));
    const keys = await generateKeyPair("RS256", { extractable: true });
    privateKey = keys.privateKey;
    const jwk = await exportJWK(keys.publicKey);
    Object.assign(jwk, { kid: "rootline-test", alg: "RS256", use: "sig" });
    const jwksPath = join(directory, "jwks.json");
    await writeFile(jwksPath, JSON.stringify({ keys: [jwk] }), "utf8");
    fixture = await createTestApplication({
      databaseUrl: process.env.DATABASE_URL,
      issuer: ISSUER,
      audience: AUDIENCE,
      jwksPath,
      rateLimit: 60,
    });
    await fixture.app.listen(0, "127.0.0.1");
    const address = fixture.server.address();
    if (!address || typeof address === "string") throw new Error("Test API did not bind a TCP port");
    apiUrl = `http://127.0.0.1:${address.port}`;
    postgres = new PrismaClient({
      datasources: { db: { url: process.env.DATABASE_URL } },
    });
    await postgres.$connect();
    await fixture.resetDatabase();
  });

  afterAll(async () => {
    await postgres?.$disconnect();
    await fixture?.close();
    if (directory) await rm(directory, { recursive: true, force: true });
  });

  async function token(
    sub: string,
    overrides: { issuer?: string; audience?: string; permissions?: string[] } = {},
  ): Promise<string> {
    return new SignJWT({ permissions: overrides.permissions ?? ["rootline:profiles:sync"] })
      .setProtectedHeader({ alg: "RS256", kid: "rootline-test" })
      .setSubject(sub)
      .setIssuer(overrides.issuer ?? ISSUER)
      .setAudience(overrides.audience ?? AUDIENCE)
      .setIssuedAt()
      .setExpirationTime("5m")
      .sign(privateKey);
  }

  function mutation(id: string, name: string, mutationId: string) {
    return {
      mutationId,
      kind: "upsert",
      occurredAt: "2026-08-15T00:00:00.000Z",
      profile: {
        id,
        name,
        sourcePath: "/Users/alice/source",
        targetPath: "D:\\backups\\alice",
        exclusions: [".git"],
        createdAt: "2026-08-15T00:00:00.000Z",
        updatedAt: "2026-08-15T00:00:00.000Z",
        syncMode: "additive",
      },
    };
  }

  test("keeps health public and rejects wrong issuer, audience, or permission", async () => {
    await request(fixture.server).get("/healthz").expect(200, { status: "ok", buildId: "development" });
    const body = { deviceId: "device-a", epoch: EPOCH, mutations: [] };
    await request(fixture.server).post("/v1/sync").send(body).expect(401);
    await request(fixture.server)
      .post("/v1/sync").set("Authorization", `Bearer ${await token("auth-a", { issuer: "https://evil.invalid/" })}`).send(body).expect(401);
    await request(fixture.server)
      .post("/v1/sync").set("Authorization", `Bearer ${await token("auth-a", { audience: "another-client" })}`).send(body).expect(401);
    await request(fixture.server)
      .post("/v1/sync").set("Authorization", `Bearer ${await token("auth-a", { permissions: [] })}`).send(body).expect(403);
  });

  test("is tenant scoped, idempotent, and assigns LWW by commit arrival", async () => {
    const alice = await token("tenant-alice");
    const bob = await token("tenant-bob");
    const first = mutation(PROFILE_ID, "First", "00000000-0000-4000-8000-000000000201");
    const laterArrivalWithOlderClock = {
      ...mutation(PROFILE_ID, "Arrival wins", "00000000-0000-4000-8000-000000000202"),
      occurredAt: "2020-01-01T00:00:00.000Z",
      profile: { ...mutation(PROFILE_ID, "Arrival wins", "x").profile, updatedAt: "2020-01-01T00:00:00.000Z" },
    };

    const firstResponse = await request(fixture.server).post("/v1/sync").set("Authorization", `Bearer ${alice}`)
      .send({ deviceId: "alice-1", epoch: EPOCH, mutations: [first] }).expect(200);
    expect(firstResponse.body.receipts).toEqual([{ mutationId: first.mutationId, revision: 1 }]);
    const replay = await request(fixture.server).post("/v1/sync").set("Authorization", `Bearer ${alice}`)
      .send({ deviceId: "alice-1", epoch: EPOCH, mutations: [first] }).expect(200);
    expect(replay.body.receipts).toEqual(firstResponse.body.receipts);
    await request(fixture.server).post("/v1/sync").set("Authorization", `Bearer ${alice}`)
      .send({ deviceId: "alice-1", epoch: EPOCH, mutations: [{ ...first, profile: { ...first.profile, name: "Collision" } }] }).expect(409);

    const arrived = await request(fixture.server).post("/v1/sync").set("Authorization", `Bearer ${alice}`)
      .send({ deviceId: "alice-2", epoch: EPOCH, cursor: firstResponse.body.cursor, mutations: [laterArrivalWithOlderClock] }).expect(200);
    expect(arrived.body.records).toEqual([expect.objectContaining({ kind: "profile", revision: 2, profile: expect.objectContaining({ name: "Arrival wins" }) })]);

    const isolated = await request(fixture.server).post("/v1/sync").set("Authorization", `Bearer ${bob}`)
      .send({ deviceId: "bob-1", epoch: EPOCH, mutations: [] }).expect(200);
    expect(isolated.body.records).toEqual([]);
  });

  test("keeps mutation idempotency for the account epoch after the 90-day receipt expires", async () => {
    const subject = "durable-dedup-user";
    const auth = await token(subject);
    const original = mutation(PROFILE_ID, "Original", "00000000-0000-4000-8000-000000000211");
    const newer = mutation(PROFILE_ID, "Newer", "00000000-0000-4000-8000-000000000212");

    const revisionOne = await request(fixture.server).post("/v1/sync").set("Authorization", `Bearer ${auth}`)
      .send({ deviceId: "dedup-a", epoch: EPOCH, mutations: [original] }).expect(200);
    const revisionTwo = await request(fixture.server).post("/v1/sync").set("Authorization", `Bearer ${auth}`)
      .send({ deviceId: "dedup-b", epoch: EPOCH, cursor: revisionOne.body.cursor, mutations: [newer] }).expect(200);

    await postgres.$executeRaw`
      UPDATE "mutation_receipt"
      SET "expires_at" = NOW() - INTERVAL '1 day'
      WHERE "subject" = ${subject} AND "mutation_id" = ${original.mutationId}::uuid
    `;
    const replay = await request(fixture.server).post("/v1/sync").set("Authorization", `Bearer ${auth}`)
      .send({ deviceId: "dedup-a", epoch: EPOCH, cursor: revisionTwo.body.cursor, mutations: [original] }).expect(200);

    expect(replay.body.receipts).toEqual([{ mutationId: original.mutationId, revision: 1 }]);
    expect(replay.body.records).toEqual([]);
    const state = await postgres.$queryRaw<Array<{ revision: bigint }>>`
      SELECT "revision" FROM "user_sync_state" WHERE "subject" = ${subject}
    `;
    const profile = await postgres.$queryRaw<Array<{ profile: { name: string } }>>`
      SELECT "profile" FROM "profile_record" WHERE "subject" = ${subject} AND "profile_id" = ${PROFILE_ID}
    `;
    const changes = await postgres.$queryRaw<Array<{ count: bigint }>>`
      SELECT COUNT(*)::bigint AS "count" FROM "sync_change" WHERE "subject" = ${subject}
    `;
    const receipts = await postgres.$queryRaw<Array<{ count: bigint }>>`
      SELECT COUNT(*)::bigint AS "count" FROM "mutation_receipt"
      WHERE "subject" = ${subject} AND "mutation_id" = ${original.mutationId}::uuid
    `;
    expect(state[0]?.revision).toBe(2n);
    expect(profile[0]?.profile.name).toBe("Newer");
    expect(changes[0]?.count).toBe(2n);
    expect(receipts[0]?.count).toBe(0n);

    await request(fixture.server).post("/v1/sync").set("Authorization", `Bearer ${auth}`)
      .send({
        deviceId: "dedup-a",
        epoch: EPOCH,
        cursor: revisionTwo.body.cursor,
        mutations: [{ ...original, profile: { ...original.profile, name: "Collision" } }],
      }).expect(409);

    await request(fixture.server).delete("/v1/account-data").set("Authorization", `Bearer ${auth}`)
      .send({ epoch: EPOCH }).expect(200);
    const ledger = await postgres.$queryRaw<Array<{ count: bigint }>>`
      SELECT COUNT(*)::bigint AS "count" FROM "mutation_dedup" WHERE "subject" = ${subject}
    `;
    expect(ledger[0]?.count).toBe(0n);
  });

  test("returns cursor deltas and tombstones without resurrecting profiles", async () => {
    const auth = await token("delta-user");
    const upsert = mutation(PROFILE_ID, "Delta", "00000000-0000-4000-8000-000000000301");
    const initial = await request(fixture.server).post("/v1/sync").set("Authorization", `Bearer ${auth}`)
      .send({ deviceId: "delta-a", epoch: EPOCH, mutations: [upsert] }).expect(200);
    const deletion = {
      mutationId: "00000000-0000-4000-8000-000000000302",
      kind: "delete",
      profileId: PROFILE_ID,
      occurredAt: "2026-08-15T00:01:00.000Z",
    };
    const delta = await request(fixture.server).post("/v1/sync").set("Authorization", `Bearer ${auth}`)
      .send({ deviceId: "delta-b", epoch: EPOCH, cursor: initial.body.cursor, mutations: [deletion] }).expect(200);
    expect(delta.body.records).toEqual([expect.objectContaining({ kind: "tombstone", profileId: PROFILE_ID, revision: 2 })]);
    const empty = await request(fixture.server).post("/v1/sync").set("Authorization", `Bearer ${auth}`)
      .send({ deviceId: "delta-c", epoch: EPOCH, cursor: delta.body.cursor, mutations: [] }).expect(200);
    expect(empty.body.records).toEqual([]);
  });

  test("replays a real desktop SQLite device-two outbox through Nest and PostgreSQL without cross-account path leakage", async () => {
    const alice = await token("seam-alice");
    const bob = await token("seam-bob");
    await request(fixture.server).post("/v1/sync").set("Authorization", `Bearer ${alice}`)
      .send({
        deviceId: "device-one",
        epoch: EPOCH,
        mutations: [mutation("device-one-profile", "Device one", "00000000-0000-4000-8008-000000000001")],
      }).expect(200);

    const manifest = fileURLToPath(new URL("../../desktop/src-tauri/Cargo.toml", import.meta.url));
    await execFileAsync("cargo", [
      "test", "--manifest-path", manifest, "--test", "hosted_sync_postgres", "--", "--ignored", "--nocapture",
    ], {
      env: {
        ...process.env,
        ROOTLINE_E2E_API_URL: apiUrl,
        ROOTLINE_E2E_ALICE_TOKEN: alice,
        ROOTLINE_E2E_BOB_TOKEN: bob,
      },
      maxBuffer: 2 * 1024 * 1024,
      timeout: 180_000,
    });

    const aliceRecords = await request(fixture.server).post("/v1/sync").set("Authorization", `Bearer ${alice}`)
      .send({ deviceId: "verification-device", epoch: EPOCH, mutations: [] }).expect(200);
    expect(aliceRecords.body.records).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "profile", profile: expect.objectContaining({ id: "device-two-offline-profile" }) }),
    ]));
  }, 180_000);

  test("rotates epoch on account deletion and rejects stale-device resurrection", async () => {
    const auth = await token("reset-user");
    await request(fixture.server).post("/v1/sync").set("Authorization", `Bearer ${auth}`)
      .send({ deviceId: "reset-a", epoch: EPOCH, mutations: [mutation(PROFILE_ID, "Before delete", "00000000-0000-4000-8000-000000000401")] }).expect(200);
    const deleted = await request(fixture.server).delete("/v1/account-data").set("Authorization", `Bearer ${auth}`)
      .send({ epoch: EPOCH }).expect(200);
    expect(deleted.body.epoch).not.toBe(EPOCH);
    const stale = await request(fixture.server).post("/v1/sync").set("Authorization", `Bearer ${auth}`)
      .send({ deviceId: "stale-device", epoch: EPOCH, mutations: [mutation(PROFILE_ID, "Must not return", "00000000-0000-4000-8000-000000000402")] }).expect(409);
    expect(stale.body).toEqual(expect.objectContaining({ code: "SYNC_EPOCH_RESET_REQUIRED", epoch: deleted.body.epoch }));
    const current = await request(fixture.server).post("/v1/sync").set("Authorization", `Bearer ${auth}`)
      .send({ deviceId: "fresh-device", epoch: deleted.body.epoch, mutations: [] }).expect(200);
    expect(current.body.records).toEqual([]);
  });

  test("paginates bounded cursor deltas for a long-offline device", async () => {
    const auth = await token("pagination-user");
    const firstBatch = Array.from({ length: 100 }, (_, index) => mutation(
      `profile-page-${index}`,
      `Page ${index}`,
      `00000000-0000-4000-8003-${String(index).padStart(12, "0")}`,
    ));
    const first = await request(fixture.server).post("/v1/sync").set("Authorization", `Bearer ${auth}`)
      .send({ deviceId: "writer", epoch: EPOCH, mutations: firstBatch }).expect(200);
    const lastMutation = mutation("profile-page-last", "Last page", "00000000-0000-4000-8003-999999999999");
    await request(fixture.server).post("/v1/sync").set("Authorization", `Bearer ${auth}`)
      .send({ deviceId: "writer", epoch: EPOCH, cursor: first.body.cursor, mutations: [lastMutation] }).expect(200);

    const pageOne = await request(fixture.server).post("/v1/sync").set("Authorization", `Bearer ${auth}`)
      .send({ deviceId: "offline-reader", epoch: EPOCH, mutations: [] }).expect(200);
    expect(pageOne.body.records).toHaveLength(100);
    expect(pageOne.body.hasMore).toBe(true);
    const pageTwo = await request(fixture.server).post("/v1/sync").set("Authorization", `Bearer ${auth}`)
      .send({ deviceId: "offline-reader", epoch: EPOCH, cursor: pageOne.body.cursor, mutations: [] }).expect(200);
    expect(pageTwo.body.records).toHaveLength(1);
    expect(pageTwo.body.hasMore).toBe(false);
    await request(fixture.server).post("/v1/sync").set("Authorization", `Bearer ${auth}`)
      .send({ deviceId: "offline-reader", epoch: EPOCH, cursor: "not-a-cursor", mutations: [] }).expect(400);
  });

  test("enforces the shared profile limits at their exact boundaries", async () => {
    const auth = await token("profile-limit-user");
    const exactCodePoints = (count: number) => "✈️".repeat(Math.floor(count / 2)) + (count % 2 ? "x" : "");
    const boundary = mutation(PROFILE_ID, exactCodePoints(80), "00000000-0000-4000-8000-000000000521");
    boundary.profile.sourcePath = exactCodePoints(4096);
    boundary.profile.targetPath = exactCodePoints(4096);
    boundary.profile.exclusions = Array.from({ length: 100 }, () => exactCodePoints(256));
    await request(fixture.server).post("/v1/sync").set("Authorization", `Bearer ${auth}`)
      .send({ deviceId: "profile-limits", epoch: EPOCH, mutations: [boundary] }).expect(200);

    const invalidProfiles = [
      { ...boundary.profile, name: exactCodePoints(81) },
      { ...boundary.profile, sourcePath: "" },
      { ...boundary.profile, targetPath: exactCodePoints(4097) },
      { ...boundary.profile, exclusions: Array.from({ length: 101 }, () => "x") },
      { ...boundary.profile, exclusions: [""] },
      { ...boundary.profile, exclusions: [exactCodePoints(257)] },
    ];
    for (const [index, profile] of invalidProfiles.entries()) {
      const invalid = {
        ...boundary,
        mutationId: `00000000-0000-4000-8000-${String(522 + index).padStart(12, "0")}`,
        profile,
      };
      await request(fixture.server).post("/v1/sync").set("Authorization", `Bearer ${auth}`)
        .send({ deviceId: "profile-limits", epoch: EPOCH, mutations: [invalid] }).expect(400);
    }
  });

  test("enforces DTO, body, and per-user request limits", async () => {
    const auth = await token("limits-user");
    const invalid = mutation(PROFILE_ID, "x".repeat(121), "00000000-0000-4000-8000-000000000501");
    await request(fixture.server).post("/v1/sync").set("Authorization", `Bearer ${auth}`)
      .send({ deviceId: "limits", epoch: EPOCH, mutations: [invalid] }).expect(400);
    const tooMany = Array.from({ length: 101 }, (_, index) => mutation(
      `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
      "Profile",
      `00000000-0000-4000-8001-${String(index).padStart(12, "0")}`,
    ));
    await request(fixture.server).post("/v1/sync").set("Authorization", `Bearer ${auth}`)
      .send({ deviceId: "limits", epoch: EPOCH, mutations: tooMany }).expect(400);
    const errorLog = vi.spyOn(Logger.prototype, "error");
    await request(fixture.server).post("/v1/sync").set("Authorization", `Bearer ${auth}`)
      .set("Content-Type", "application/json").send(JSON.stringify({ padding: "x".repeat(256 * 1024) })).expect(413);
    expect(errorLog).not.toHaveBeenCalled();
    errorLog.mockRestore();

    for (let index = 0; index < 58; index += 1) {
      await request(fixture.server).post("/v1/sync").set("Authorization", `Bearer ${auth}`)
        .send({ deviceId: "limits", epoch: EPOCH, mutations: [] }).expect(200);
    }
    await request(fixture.server).post("/v1/sync").set("Authorization", `Bearer ${auth}`)
      .send({ deviceId: "limits", epoch: EPOCH, mutations: [] }).expect(429);
  });
});
