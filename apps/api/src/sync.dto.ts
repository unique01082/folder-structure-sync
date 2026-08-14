import { Type } from "class-transformer";
import {
  ArrayMaxSize, IsArray, IsDateString, IsIn, IsOptional, IsString, IsUUID, MaxLength, MinLength, ValidateNested,
} from "class-validator";

export class SyncProfileDto {
  @IsString() @MinLength(1) @MaxLength(128) id!: string;
  @IsString() @MinLength(1) @MaxLength(120) name!: string;
  @IsString() @MinLength(1) @MaxLength(4096) sourcePath!: string;
  @IsString() @MinLength(1) @MaxLength(4096) targetPath!: string;
  @IsArray() @ArrayMaxSize(100) @IsString({ each: true }) @MaxLength(512, { each: true }) exclusions!: string[];
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
