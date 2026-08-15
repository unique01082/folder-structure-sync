import { Type } from "class-transformer";
import { PROFILE_LIMITS } from "@rootline/contracts";
import {
  ArrayMaxSize, IsArray, IsDateString, IsIn, IsOptional, IsString, IsUUID, MaxLength, MinLength, ValidateNested,
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
  @IsDateString() createdAt!: string;
  @IsDateString() updatedAt!: string;
  @IsOptional() @IsIn(["additive"]) syncMode?: "additive";
}

export class ProfileMutationDto {
  @IsUUID() mutationId!: string;
  @IsIn(["upsert", "delete"]) kind!: "upsert" | "delete";
  @IsDateString() occurredAt!: string;
  @IsOptional() @ValidateNested() @Type(() => SyncProfileDto) profile?: SyncProfileDto;
  @IsOptional() @IsString() @MinLength(1) @MaxLength(128) profileId?: string;
}

export class SyncRequestDto {
  @IsString() @MinLength(1) @MaxLength(128) deviceId!: string;
  @IsUUID() epoch!: string;
  @IsOptional() @IsString() @MaxLength(512) cursor?: string;
  @IsArray() @ArrayMaxSize(100) @ValidateNested({ each: true }) @Type(() => ProfileMutationDto) mutations!: ProfileMutationDto[];
}

export class DeleteAccountDataDto {
  @IsUUID() epoch!: string;
}
