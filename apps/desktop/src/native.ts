import { invoke } from "@tauri-apps/api/core";

export interface Profile {
  id: string;
  name: string;
  sourcePath: string;
  targetPath: string;
  exclusions: string[];
  createdAt: string;
  updatedAt: string;
}

export interface ScanRequest {
  operationId: string;
  sourcePath: string;
  targetPath: string;
  exclusions: string[];
}

export interface ScanPlan {
  operationId: string;
  sourceFingerprint: string;
  targetFingerprint: string;
  targetCaseSensitive: boolean;
  planFingerprint: string;
  missing: string[];
  skippedLinks: string[];
}

export type DirectoryStatus = "created" | "already-exists" | "failed";

export interface ApplyResult {
  runId: string;
  startedAt: string;
  finishedAt: string;
  directories: Array<{ relativePath: string; status: DirectoryStatus; error?: string }>;
}

export interface NativeGateway {
  chooseFolder(input: { role: "source" | "target" }): Promise<string | null>;
  scan(request: ScanRequest): Promise<ScanPlan>;
  apply(input: { request: ScanRequest; plan: ScanPlan; selected: string[]; profileId?: string }): Promise<ApplyResult>;
  cancel(operationId: string): Promise<void>;
  listProfiles(): Promise<Profile[]>;
  saveProfile(profile: Profile): Promise<Profile>;
  deleteProfile(id: string): Promise<void>;
}

export const tauriGateway: NativeGateway = {
  chooseFolder: ({ role }) => invoke<string | null>("choose_folder", { role }),
  scan: (request) => invoke<ScanPlan>("scan_directories", { request }),
  apply: (command) => invoke<ApplyResult>("apply_directories", { command }),
  cancel: (operationId) => invoke<void>("cancel_operation", { operationId }),
  listProfiles: () => invoke<Profile[]>("list_profiles"),
  saveProfile: (profile) => invoke<Profile>("save_profile", { profile }),
  deleteProfile: (id) => invoke<void>("delete_profile", { id }),
};

export interface NativeFailure {
  code: string;
  message: string;
  details?: Record<string, unknown>;
}

export function nativeFailure(error: unknown): NativeFailure {
  if (typeof error === "object" && error !== null && "code" in error) {
    const value = error as Partial<NativeFailure>;
    return {
      code: typeof value.code === "string" ? value.code : "INTERNAL",
      message: typeof value.message === "string" ? value.message : "Unexpected native error.",
      ...(value.details ? { details: value.details } : {}),
    };
  }
  return { code: "INTERNAL", message: error instanceof Error ? error.message : "Unexpected native error." };
}
