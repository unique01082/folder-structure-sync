import { beforeEach, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  load: vi.fn(),
  save: vi.fn(),
  values: new Map<string, Uint8Array>(),
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("@tauri-apps/api/path", () => ({
  appDataDir: vi.fn(async () => "/protected/app-data"),
  join: vi.fn(async (...parts: string[]) => parts.join("/")),
}));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));
vi.mock("@tauri-apps/plugin-deep-link", () => ({ getCurrent: vi.fn(), onOpenUrl: vi.fn() }));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn() }));
vi.mock("@tauri-apps/plugin-stronghold", () => ({
  Stronghold: { load: mocks.load },
}));

import { StrongholdAsyncStorage } from "../auth";

beforeEach(() => {
  mocks.values.clear();
  mocks.invoke.mockReset().mockResolvedValue("a".repeat(64));
  mocks.save.mockReset().mockResolvedValue(undefined);
  const store = {
    get: vi.fn(async (key: string) => mocks.values.get(key) ?? null),
    insert: vi.fn(async (key: string, value: number[]) => { mocks.values.set(key, Uint8Array.from(value)); }),
    remove: vi.fn(async (key: string) => { mocks.values.delete(key); return null; }),
  };
  const client = { getStore: () => store };
  mocks.load.mockReset().mockResolvedValue({
    loadClient: vi.fn(async () => { throw new Error("first install"); }),
    createClient: vi.fn(async () => client),
    save: mocks.save,
  });
});

test("persists OIDC state and tokens only through the OS-keyed Stronghold store", async () => {
  const browserWrite = vi.spyOn(Storage.prototype, "setItem");
  const storage = new StrongholdAsyncStorage();
  await storage.setItem("oidc.user", JSON.stringify({ access_token: "secret-token" }));
  expect(mocks.invoke).toHaveBeenCalledWith("auth_vault_password");
  expect(mocks.load).toHaveBeenCalledWith("/protected/app-data/rootline-auth.stronghold", "a".repeat(64));
  expect(await storage.getItem("oidc.user")).toContain("secret-token");
  expect(browserWrite).not.toHaveBeenCalled();
  expect(mocks.save).toHaveBeenCalled();
  browserWrite.mockRestore();
});

test("fails closed when the native OS credential boundary cannot return the existing vault key", async () => {
  const browserWrite = vi.spyOn(Storage.prototype, "setItem");
  mocks.invoke.mockRejectedValueOnce(new Error("Stronghold vault exists but its OS-protected key is missing."));
  const storage = new StrongholdAsyncStorage();
  await expect(storage.setItem("oidc.user", "must-not-persist")).rejects.toThrow(/OS-protected key is missing/);
  expect(mocks.load).not.toHaveBeenCalled();
  expect(browserWrite).not.toHaveBeenCalled();
  browserWrite.mockRestore();
});
