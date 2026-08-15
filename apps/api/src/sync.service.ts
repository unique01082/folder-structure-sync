import { BadRequestException, ConflictException, Inject, Injectable } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { createHash, randomUUID } from "node:crypto";

import { PrismaService } from "./prisma.service.js";
import type { DeleteAccountDataDto, ProfileMutationDto, SyncRequestDto } from "./sync.dto.js";

const RECEIPT_TTL_MS = 90 * 24 * 60 * 60 * 1000;
const DELTA_RECORD_LIMIT = 100;
const DELTA_BODY_BUDGET = 1024 * 1024;

function encodeCursor(epoch: string, revision: bigint): string {
  return Buffer.from(JSON.stringify({ epoch, revision: revision.toString() }), "utf8").toString("base64url");
}

function decodeCursor(cursor: string | undefined, epoch: string): bigint {
  if (!cursor) return 0n;
  try {
    const value = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as { epoch?: unknown; revision?: unknown };
    if (typeof value.epoch !== "string" || typeof value.revision !== "string" || !/^\d+$/.test(value.revision)) throw new Error();
    if (value.epoch !== epoch) throw new ConflictException({ code: "SYNC_EPOCH_RESET_REQUIRED", epoch });
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

function mutationHash(mutation: ProfileMutationDto): string {
  return createHash("sha256").update(JSON.stringify(canonical(mutation))).digest("hex");
}

function validateShape(mutation: ProfileMutationDto): void {
  if (mutation.kind === "upsert" && (!mutation.profile || mutation.profileId)) throw new BadRequestException("An upsert requires only profile.");
  if (mutation.kind === "delete" && (!mutation.profileId || mutation.profile)) throw new BadRequestException("A delete requires only profileId.");
}

@Injectable()
export class SyncService {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  async sync(subject: string, dto: SyncRequestDto) {
    dto.mutations.forEach(validateShape);
    const requestedRevision = decodeCursor(dto.cursor, dto.epoch);
    return this.prisma.$transaction(async (tx) => {
      await tx.userSyncState.upsert({ where: { subject }, update: {}, create: { subject, epoch: dto.epoch } });
      await tx.$queryRaw`SELECT "subject" FROM "user_sync_state" WHERE "subject" = ${subject} FOR UPDATE`;
      const state = await tx.userSyncState.findUniqueOrThrow({ where: { subject } });
      if (state.epoch !== dto.epoch) throw new ConflictException({ code: "SYNC_EPOCH_RESET_REQUIRED", epoch: state.epoch });
      if (requestedRevision > state.revision) throw new BadRequestException("Cursor revision is ahead of the server.");
      await tx.mutationReceipt.deleteMany({ where: { expiresAt: { lte: new Date() } } });

      let revision = state.revision;
      const receipts: Array<{ mutationId: string; revision: number }> = [];
      for (const mutation of dto.mutations) {
        const hash = mutationHash(mutation);
        const prior = await tx.mutationDedup.findUnique({ where: { subject_mutationId: { subject, mutationId: mutation.mutationId } } });
        if (prior) {
          if (prior.mutationHash !== hash) throw new ConflictException("A mutation ID cannot be reused for different profile data.");
          receipts.push({ mutationId: mutation.mutationId, revision: Number(prior.revision) });
          continue;
        }
        revision += 1n;
        const committedAt = new Date();
        const record = mutation.kind === "upsert"
          ? { kind: "profile", profile: mutation.profile!, revision: Number(revision) }
          : { kind: "tombstone", profileId: mutation.profileId!, deletedAt: committedAt.toISOString(), revision: Number(revision) };
        await tx.profileRecord.upsert({
          where: { subject_profileId: { subject, profileId: mutation.kind === "upsert" ? mutation.profile!.id : mutation.profileId! } },
          create: {
            subject, profileId: mutation.kind === "upsert" ? mutation.profile!.id : mutation.profileId!, kind: mutation.kind === "upsert" ? "profile" : "tombstone",
            profile: mutation.kind === "upsert" ? json(mutation.profile) : Prisma.JsonNull,
            deletedAt: mutation.kind === "delete" ? committedAt : null, revision, committedAt,
          },
          update: {
            kind: mutation.kind === "upsert" ? "profile" : "tombstone",
            profile: mutation.kind === "upsert" ? json(mutation.profile) : Prisma.JsonNull,
            deletedAt: mutation.kind === "delete" ? committedAt : null, revision, committedAt,
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
        cursor: encodeCursor(state.epoch, cursorRevision),
        hasMore: cursorRevision < revision,
        records,
        receipts,
      };
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
  }

  async deleteAccountData(subject: string, dto: DeleteAccountDataDto) {
    return this.prisma.$transaction(async (tx) => {
      await tx.userSyncState.upsert({ where: { subject }, update: {}, create: { subject, epoch: dto.epoch } });
      await tx.$queryRaw`SELECT "subject" FROM "user_sync_state" WHERE "subject" = ${subject} FOR UPDATE`;
      const state = await tx.userSyncState.findUniqueOrThrow({ where: { subject } });
      if (state.epoch !== dto.epoch) throw new ConflictException({ code: "SYNC_EPOCH_RESET_REQUIRED", epoch: state.epoch });
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
