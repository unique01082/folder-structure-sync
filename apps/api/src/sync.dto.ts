import { Type } from "class-transformer";
import { PROFILE_LIMITS } from "@rootline/contracts";
import {
  ArrayMaxSize, IsArray, IsDateString, IsIn, IsInt, IsOptional, IsString, IsUUID, MaxLength, MinLength, ValidateNested,
} from "class-validator";
import { CodePointLength } from "./code-point-length.validator.js";

export class SyncProfileDto {
  @IsString() @MinLength(1) @MaxLength(128) id!: string;
  @IsString() @CodePointLength(PROFILE_LIMITS.name.min, PROFILE_LIMITS.name.max) name!: string;
  @IsString() @CodePointLength(PROFILE_LIMITS.path.min, PROFILE_LIMITS.path.max) sourcePath!: string;
  @IsString() @CodePointLength(PROFILE_LIMITS.path.min, PROFILE_LIMITS.path.max) targetPath!: string;
  @IsArray()
  @ArrayMaxSize(PROFILE_LIMITS.exclusions.max)
  @IsString({ each: true })
  @CodePointLength(PROFILE_LIMITS.exclusions.pattern.min, PROFILE_LIMITS.exclusions.pattern.max, { each: true })
  exclusions!: string[];
  @IsOptional() @IsDateString() createdAt?: string;
  @IsOptional() @IsDateString() updatedAt?: string;
  @IsOptional() @IsIn(["additive"]) syncMode?: "additive";
  @IsOptional() @IsInt() schemaVersion?: number;
  @IsOptional() @IsString() @MaxLength(128) revision?: string;
  @IsOptional() @IsDateString() deletedAt?: string | null;
}

export class ProfileMutationDto {
  @IsUUID() mutationId!: string;
  @IsOptional() @IsIn(["upsert", "delete"]) kind?: "upsert" | "delete";
  @IsOptional() @IsIn(["upsert", "delete"]) type?: "upsert" | "delete";
  @IsOptional() @IsDateString() occurredAt?: string;
  @IsOptional() @ValidateNested() @Type(() => SyncProfileDto) profile?: SyncProfileDto;
  @IsOptional() @IsString() @MinLength(1) @MaxLength(128) profileId?: string;
}

export class SyncRequestDto {
  @IsString() @MinLength(1) @MaxLength(128) deviceId!: string;
  @IsOptional() @IsUUID() epoch?: string;
  @IsOptional() @IsUUID() accountEpoch?: string | null;
  @IsOptional() @IsString() @MaxLength(512) cursor?: string;
  @IsArray() @ArrayMaxSize(100) @ValidateNested({ each: true }) @Type(() => ProfileMutationDto) mutations!: ProfileMutationDto[];
}

export class DeleteAccountDataDto {
  @IsUUID() epoch!: string;
}
