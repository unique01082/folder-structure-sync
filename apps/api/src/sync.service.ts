import { BadRequestException, ConflictException, Inject, Injectable } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { ROOTLINE_ERROR_CODES } from "@rootline/contracts";
import { createHash, randomUUID } from "node:crypto";

import { PrismaService } from "./prisma.service.js";
import type { DeleteAccountDataDto, SyncProfileDto, SyncRequestDto } from "./sync.dto.js";

const RECEIPT_TTL_MS = 90 * 24 * 60 * 60 * 1000;
const DELTA_RECORD_LIMIT = 100;
const DELTA_BODY_BUDGET = 1024 * 1024;
const PUBLIC_PROFILE_TIMESTAMP = "1970-01-01T00:00:00.000Z";

interface NormalizedProfile {
  id: string;
  name: string;
  sourcePath: string;
  targetPath: string;
  exclusions: string[];
  createdAt: string;
  updatedAt: string;
  syncMode?: "additive";
}

type NormalizedMutation =
  | { mutationId: string; kind: "upsert"; profile: NormalizedProfile; occurredAt: string; publicRevision?: string }
  | { mutationId: string; kind: "delete"; profileId: string; occurredAt: string };

interface NormalizedSyncRequest {
  deviceId: string;
  epoch: string | null;
  cursor?: string;
  mutations: NormalizedMutation[];
}

function encodeCursor(epoch: string, revision: bigint): string {
  return Buffer.from(JSON.stringify({ epoch, revision: revision.toString() }), "utf8").toString("base64url");
}

function decodeCursor(cursor: string | undefined, epoch: string): bigint {
  if (!cursor) return 0n;
  try {
    const value = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as { epoch?: unknown; revision?: unknown };
    if (typeof value.epoch !== "string" || typeof value.revision !== "string" || !/^\d+$/.test(value.revision)) throw new Error();
    if (value.epoch !== epoch) throw new ConflictException({ code: ROOTLINE_ERROR_CODES.RESET_REQUIRED, epoch });
    return BigInt(value.revision);
  } catch (error) {
    if (error instanceof ConflictException) throw error;
    throw new BadRequestException("Cursor is invalid.");
  }
}

function json(value: unknown): Prisma.InputJsonValue {
  return value as Prisma.InputJsonValue;
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => [key, canonical(item)]));
  }
  return value;
}

function mutationHash(mutation: NormalizedMutation): string {
  return createHash("sha256").update(JSON.stringify(canonical(mutation))).digest("hex");
}

function normalizeProfile(profile: SyncProfileDto, publicContract: boolean): NormalizedProfile {
  if (publicContract) {
    if (profile.schemaVersion !== 1) throw new BadRequestException({ code: "SCHEMA_UNSUPPORTED" });
    if (profile.revision === undefined || profile.deletedAt !== null || profile.createdAt !== undefined || profile.updatedAt !== undefined || profile.syncMode !== undefined) {
      throw new BadRequestException("A public v1 upsert requires revision, deletedAt null, and no internal timestamps.");
    }
    return {
      id: profile.id,
      name: profile.name,
      sourcePath: profile.sourcePath,
      targetPath: profile.targetPath,
      exclusions: profile.exclusions,
      createdAt: PUBLIC_PROFILE_TIMESTAMP,
      updatedAt: PUBLIC_PROFILE_TIMESTAMP,
      syncMode: "additive",
    };
  }
  if (!profile.createdAt || !profile.updatedAt || profile.schemaVersion !== undefined || profile.revision !== undefined || profile.deletedAt !== undefined) {
    throw new BadRequestException("An internal profile requires timestamps and cannot mix public v1 fields.");
  }
  return {
    id: profile.id,
    name: profile.name,
    sourcePath: profile.sourcePath,
    targetPath: profile.targetPath,
    exclusions: profile.exclusions,
    createdAt: profile.createdAt,
    updatedAt: profile.updatedAt,
    ...(profile.syncMode ? { syncMode: profile.syncMode } : {}),
  };
}

function normalizeRequest(dto: SyncRequestDto): NormalizedSyncRequest {
  const publicContract = dto.accountEpoch !== undefined || dto.mutations.some((mutation) => mutation.type !== undefined);
  if (publicContract && dto.epoch !== undefined) throw new BadRequestException("Public and internal epoch fields cannot be mixed.");
  if (!publicContract && (!dto.epoch || dto.accountEpoch !== undefined)) throw new BadRequestException("An epoch is required.");
  const mutations = dto.mutations.map((mutation): NormalizedMutation => {
    if (publicContract) {
      if (!mutation.type || mutation.kind !== undefined || mutation.occurredAt !== undefined) {
        throw new BadRequestException("A public mutation requires only its type discriminant.");
      }
      if (mutation.type === "upsert") {
        if (!mutation.profile || mutation.profileId || mutation.profile.revision === undefined) {
          throw new BadRequestException("A public upsert requires only a revisioned profile.");
        }
        return {
          mutationId: mutation.mutationId,
          kind: "upsert",
          profile: normalizeProfile(mutation.profile, true),
          occurredAt: PUBLIC_PROFILE_TIMESTAMP,
          publicRevision: mutation.profile.revision,
        };
      }
      if (!mutation.profileId || mutation.profile) throw new BadRequestException("A delete requires only profileId.");
      return { mutationId: mutation.mutationId, kind: "delete", profileId: mutation.profileId, occurredAt: PUBLIC_PROFILE_TIMESTAMP };
    }
    if (!mutation.kind || mutation.type !== undefined || !mutation.occurredAt) {
      throw new BadRequestException("An internal mutation requires kind and occurredAt.");
    }
    if (mutation.kind === "upsert") {
      if (!mutation.profile || mutation.profileId) throw new BadRequestException("An upsert requires only profile.");
      return { mutationId: mutation.mutationId, kind: "upsert", profile: normalizeProfile(mutation.profile, false), occurredAt: mutation.occurredAt };
    }
    if (!mutation.profileId || mutation.profile) throw new BadRequestException("A delete requires only profileId.");
    return { mutationId: mutation.mutationId, kind: "delete", profileId: mutation.profileId, occurredAt: mutation.occurredAt };
  });
  return {
    deviceId: dto.deviceId,
    epoch: publicContract ? dto.accountEpoch ?? null : dto.epoch!,
    ...(dto.cursor === undefined ? {} : { cursor: dto.cursor }),
    mutations,
  };
}

function publicProfile(record: Prisma.JsonValue): Record<string, unknown> | null {
  if (typeof record !== "object" || record === null || Array.isArray(record)) return null;
  const value = record as Record<string, unknown>;
  const profile = value.profile;
  if (typeof profile !== "object" || profile === null || Array.isArray(profile)) return null;
  const source = profile as Record<string, unknown>;
  if (typeof source.id !== "string" || typeof source.name !== "string" || typeof source.sourcePath !== "string"
    || typeof source.targetPath !== "string" || !Array.isArray(source.exclusions) || typeof value.revision !== "number") return null;
  return {
    id: source.id,
    schemaVersion: 1,
    name: source.name,
    sourcePath: source.sourcePath,
    targetPath: source.targetPath,
    exclusions: source.exclusions,
    revision: String(value.revision),
    deletedAt: value.kind === "tombstone" && typeof value.deletedAt === "string" ? value.deletedAt : null,
  };
}

@Injectable()
export class SyncService {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  async sync(subject: string, dto: SyncRequestDto) {
    const request = normalizeRequest(dto);
    return this.prisma.$transaction(async (tx) => {
      await tx.userSyncState.upsert({ where: { subject }, update: {}, create: { subject, epoch: request.epoch ?? randomUUID() } });
      await tx.$queryRaw`SELECT "subject" FROM "user_sync_state" WHERE "subject" = ${subject} FOR UPDATE`;
      const state = await tx.userSyncState.findUniqueOrThrow({ where: { subject } });
      if (request.epoch !== null && state.epoch !== request.epoch) {
        throw new ConflictException({ code: ROOTLINE_ERROR_CODES.RESET_REQUIRED, epoch: state.epoch });
      }
      const requestedRevision = decodeCursor(request.cursor, state.epoch);
      if (requestedRevision > state.revision) throw new BadRequestException("Cursor revision is ahead of the server.");
      await tx.mutationReceipt.deleteMany({ where: { expiresAt: { lte: new Date() } } });

      let revision = state.revision;
      const receipts: Array<{ mutationId: string; revision: number }> = [];
      for (const mutation of request.mutations) {
        const hash = mutationHash(mutation);
        const prior = await tx.mutationDedup.findUnique({ where: { subject_mutationId: { subject, mutationId: mutation.mutationId } } });
        if (prior) {
          if (prior.mutationHash !== hash) throw new ConflictException("A mutation ID cannot be reused for different profile data.");
          receipts.push({ mutationId: mutation.mutationId, revision: Number(prior.revision) });
          continue;
        }
        revision += 1n;
        const committedAt = new Date();
        const existing = mutation.kind === "delete"
          ? await tx.profileRecord.findUnique({ where: { subject_profileId: { subject, profileId: mutation.profileId } } })
          : null;
        const retainedProfile = existing?.profile && typeof existing.profile === "object" && !Array.isArray(existing.profile)
          ? existing.profile
          : null;
        const record = mutation.kind === "upsert"
          ? { kind: "profile", profile: mutation.profile!, revision: Number(revision) }
          : {
              kind: "tombstone", profileId: mutation.profileId!, deletedAt: committedAt.toISOString(), revision: Number(revision),
              ...(retainedProfile ? { profile: retainedProfile } : {}),
            };
        await tx.profileRecord.upsert({
          where: { subject_profileId: { subject, profileId: mutation.kind === "upsert" ? mutation.profile!.id : mutation.profileId! } },
          create: {
            subject, profileId: mutation.kind === "upsert" ? mutation.profile!.id : mutation.profileId!, kind: mutation.kind === "upsert" ? "profile" : "tombstone",
            profile: mutation.kind === "upsert" ? json(mutation.profile) : retainedProfile ? json(retainedProfile) : Prisma.JsonNull,
            deletedAt: mutation.kind === "delete" ? committedAt : null, revision, lastDeviceId: request.deviceId, committedAt,
          },
          update: {
            kind: mutation.kind === "upsert" ? "profile" : "tombstone",
            profile: mutation.kind === "upsert" ? json(mutation.profile) : retainedProfile ? json(retainedProfile) : Prisma.JsonNull,
            deletedAt: mutation.kind === "delete" ? committedAt : null, revision, lastDeviceId: request.deviceId, committedAt,
          },
        });
        await tx.syncChange.create({ data: { subject, revision, record: json(record), committedAt } });
        await tx.mutationDedup.create({
          data: { subject, mutationId: mutation.mutationId, mutationHash: hash, revision, createdAt: committedAt },
        });
        await tx.mutationReceipt.create({
          data: { subject, mutationId: mutation.mutationId, mutationHash: hash, revision, expiresAt: new Date(committedAt.getTime() + RECEIPT_TTL_MS) },
        });
        receipts.push({ mutationId: mutation.mutationId, revision: Number(revision) });
      }
      if (revision !== state.revision) await tx.userSyncState.update({ where: { subject }, data: { revision } });
      const candidates = await tx.syncChange.findMany({
        where: { subject, revision: { gt: requestedRevision, lte: revision } }, orderBy: { revision: "asc" },
        take: DELTA_RECORD_LIMIT + 1, select: { revision: true, record: true },
      });
      const records: Prisma.JsonValue[] = [];
      let responseBytes = 0;
      let cursorRevision = requestedRevision;
      for (const change of candidates.slice(0, DELTA_RECORD_LIMIT)) {
        const bytes = Buffer.byteLength(JSON.stringify(change.record), "utf8");
        if (records.length > 0 && responseBytes + bytes > DELTA_BODY_BUDGET) break;
        records.push(change.record);
        responseBytes += bytes;
        cursorRevision = change.revision;
      }
      return {
        epoch: state.epoch,
        accountEpoch: state.epoch,
        cursor: encodeCursor(state.epoch, cursorRevision),
        hasMore: cursorRevision < revision,
        records,
        receipts,
        acknowledgedMutationIds: receipts.map((receipt) => receipt.mutationId),
        profiles: records.map(publicProfile).filter((profile): profile is Record<string, unknown> => profile !== null),
      };
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
  }

  async deleteAccountData(subject: string, dto: DeleteAccountDataDto) {
    return this.prisma.$transaction(async (tx) => {
      await tx.userSyncState.upsert({ where: { subject }, update: {}, create: { subject, epoch: dto.epoch } });
      await tx.$queryRaw`SELECT "subject" FROM "user_sync_state" WHERE "subject" = ${subject} FOR UPDATE`;
      const state = await tx.userSyncState.findUniqueOrThrow({ where: { subject } });
      if (state.epoch !== dto.epoch) {
        throw new ConflictException({ code: ROOTLINE_ERROR_CODES.RESET_REQUIRED, epoch: state.epoch });
      }
      const epoch = randomUUID();
      await tx.profileRecord.deleteMany({ where: { subject } });
      await tx.syncChange.deleteMany({ where: { subject } });
      await tx.mutationReceipt.deleteMany({ where: { subject } });
      await tx.mutationDedup.deleteMany({ where: { subject } });
      await tx.userSyncState.update({ where: { subject }, data: { epoch, revision: 0n } });
      return { epoch };
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
  }
}
