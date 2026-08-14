import { beforeEach, describe, expect, test, vi } from "vitest";
import { OidcClient, WebStorageStateStore, type AsyncStorage } from "oidc-client-ts";

import {
  DesktopAuthController,
  OIDC_SCOPE,
  ProfileSyncCoordinator,
  createOidcSettings,
  projectUser,
  readOidcConfiguration,
  validateCallbackUrl,
  type AuthController,
  type OidcConfiguration,
} from "../auth";

const tauriMocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  listen: vi.fn(async () => vi.fn()),
  onOpenUrl: vi.fn(async () => vi.fn()),
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke: tauriMocks.invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: tauriMocks.listen }));
vi.mock("@tauri-apps/plugin-deep-link", () => ({ onOpenUrl: tauriMocks.onOpenUrl }));

class MemoryAsyncStorage implements AsyncStorage {
  private readonly values = new Map<string, string>();
  get length() { return Promise.resolve(this.values.size); }
  clear() { this.values.clear(); return Promise.resolve(); }
  getItem(key: string) { return Promise.resolve(this.values.get(key) ?? null); }
  key(index: number) { return Promise.resolve([...this.values.keys()][index] ?? null); }
  removeItem(key: string) { this.values.delete(key); return Promise.resolve(); }
  setItem(key: string, value: string) { this.values.set(key, value); return Promise.resolve(); }
}

describe("Rootline desktop authentication boundary", () => {
  const config = {
    authority: "https://auth.baole.space/application/o/rootline/",
    clientId: "rootline-desktop",
    apiUrl: "https://rootline-api.baole.space",
    redirectUri: "rootline://auth/callback" as const,
    scope: OIDC_SCOPE,
  } satisfies OidcConfiguration;

  beforeEach(() => {
    tauriMocks.invoke.mockReset();
    tauriMocks.listen.mockReset().mockResolvedValue(vi.fn());
    tauriMocks.onOpenUrl.mockReset().mockResolvedValue(vi.fn());
  });

  test("uses the public PKCE client scopes and fails closed on partial configuration", () => {
    expect(OIDC_SCOPE).toBe("openid profile email permissions offline_access");
    expect(readOidcConfiguration({})).toBeNull();
    expect(() => readOidcConfiguration({ VITE_AUTHENTIK_ISSUER: "https://auth.baole.space/application/o/rootline/" }))
      .toThrow(/CLIENT_ID/);
    expect(readOidcConfiguration({
      VITE_AUTHENTIK_ISSUER: "https://auth.baole.space/application/o/rootline/",
      VITE_AUTHENTIK_CLIENT_ID: "rootline-desktop",
      VITE_ROOTLINE_SYNC_API: "https://rootline-api.baole.space",
    })).toEqual(expect.objectContaining({
      redirectUri: "rootline://auth/callback",
      scope: OIDC_SCOPE,
    }));
  });

  test("accepts only the exact callback scheme, host, path, state, and code", () => {
    expect(validateCallbackUrl("rootline://auth/callback?code=abc&state=expected", "expected").toString())
      .toBe("rootline://auth/callback?code=abc&state=expected");
    for (const value of [
      "https://auth/callback?code=abc&state=expected",
      "rootline://evil/callback?code=abc&state=expected",
      "rootline://auth/callback/extra?code=abc&state=expected",
      "rootline://auth/callback?code=abc&state=wrong",
      "rootline://auth/callback?state=expected",
      "rootline://auth/callback?code=abc&state=expected&code=second",
    ]) expect(() => validateCallbackUrl(value, "expected")).toThrow(/AUTH_CALLBACK_INVALID/);
  });

  test("creates an actual PKCE+nonce request and consumes callback state only once outside browser storage", async () => {
    const browserWrite = vi.spyOn(Storage.prototype, "setItem");
    const storage = new MemoryAsyncStorage();
    const stateStore = new WebStorageStateStore({ prefix: "test.state.", store: storage });
    const userStore = new WebStorageStateStore({ prefix: "test.user.", store: storage });
    const authority = "https://auth.baole.space/application/o/rootline/";
    const settings = createOidcSettings({
      authority, clientId: "rootline-desktop", apiUrl: "https://rootline-api.baole.space",
      redirectUri: "rootline://auth/callback", scope: OIDC_SCOPE,
    }, stateStore, userStore);
    const client = new OidcClient({
      ...settings,
      metadata: {
        issuer: authority,
        authorization_endpoint: `${authority}authorize/`,
        token_endpoint: `${authority}token/`,
      },
    });
    const request = await client.createSigninRequest({ nonce: "nonce-must-match-id-token" });
    const url = new URL(request.url);
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("code_challenge")).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(url.searchParams.get("nonce")).toBe("nonce-must-match-id-token");
    expect(browserWrite).not.toHaveBeenCalled();

    const state = url.searchParams.get("state")!;
    await expect(client.readSigninResponseState(`rootline://auth/callback?code=x&state=wrong`, true)).rejects.toThrow(/state/i);
    const accepted = await client.readSigninResponseState(`rootline://auth/callback?code=x&state=${state}`, true);
    expect(accepted.state).toEqual(expect.objectContaining({ nonce: url.searchParams.get("nonce"), code_verifier: expect.any(String) }));
    await expect(client.readSigninResponseState(`rootline://auth/callback?code=x&state=${state}`, true)).rejects.toThrow(/state/i);
    expect(browserWrite).not.toHaveBeenCalled();

    const badNonceRequest = await client.createSigninRequest({ nonce: "expected-nonce" });
    const badNonceState = new URL(badNonceRequest.url).searchParams.get("state")!;
    const jwt = [
      Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url"),
      Buffer.from(JSON.stringify({ sub: "alice", nonce: "wrong-nonce" })).toString("base64url"),
      "signature",
    ].join(".");
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      access_token: "access", token_type: "Bearer", expires_in: 300, id_token: jwt,
    }), { status: 200, headers: { "Content-Type": "application/json" } })));
    await expect(client.processSigninResponse(`rootline://auth/callback?code=x&state=${badNonceState}`))
      .rejects.toThrow(/nonce.*does not match/i);
    vi.unstubAllGlobals();
    browserWrite.mockRestore();
  });

  test("projects identity claims without exposing access, ID, or refresh tokens", () => {
    const visible = projectUser({
      profile: { sub: "subject", name: "Alice", email: "alice@example.com", permissions: ["rootline:profiles:sync"] },
      access_token: "secret-access",
      id_token: "secret-id",
      refresh_token: "secret-refresh",
      expired: false,
    });
    expect(visible).toEqual({ sub: "subject", name: "Alice", email: "alice@example.com", permissions: ["rootline:profiles:sync"] });
    expect(JSON.stringify(visible)).not.toContain("secret-");
  });

  test("replays outbox at start, sign-in, manual sync, and a debounced profile edit while offline failures stay non-blocking", async () => {
    vi.useFakeTimers();
    const sync = vi.fn()
      .mockRejectedValueOnce(new TypeError("offline"))
      .mockResolvedValue(undefined);
    const auth = { sync } as unknown as AuthController;
    const coordinator = new ProfileSyncCoordinator(auth, 750);
    await expect(coordinator.start()).resolves.toBeUndefined();
    await coordinator.signedIn();
    await coordinator.manual();
    coordinator.profileEdited();
    coordinator.profileEdited();
    await vi.advanceTimersByTimeAsync(750);
    expect(sync).toHaveBeenCalledTimes(4);
    vi.useRealTimers();
  });

  test("initializes once, serializes callbacks, and preserves a valid session after duplicate delivery", async () => {
    const storedUser = {
      profile: { sub: "alice", name: "Alice", permissions: ["rootline:profiles:sync"] },
      access_token: "access", expired: false,
    };
    let callbacksInFlight = 0;
    let maxCallbacksInFlight = 0;
    const manager = {
      getUser: vi.fn(async () => storedUser),
      signinRedirectCallback: vi.fn(async () => {
        callbacksInFlight += 1;
        maxCallbacksInFlight = Math.max(maxCallbacksInFlight, callbacksInFlight);
        await Promise.resolve();
        callbacksInFlight -= 1;
        if (manager.signinRedirectCallback.mock.calls.length > 1) throw new Error("state already consumed");
        return storedUser;
      }),
      signinRedirect: vi.fn(), revokeTokens: vi.fn(), removeUser: vi.fn(),
    };
    tauriMocks.invoke.mockResolvedValue({});
    const auth = new DesktopAuthController(config, manager as never);
    await Promise.all([auth.initialize(), auth.initialize()]);
    expect(manager.getUser).toHaveBeenCalledTimes(1);
    expect(tauriMocks.onOpenUrl).toHaveBeenCalledTimes(1);
    expect(tauriMocks.listen).toHaveBeenCalledTimes(1);

    await Promise.all([
      auth.handleCallback("rootline://auth/callback?code=first&state=one"),
      auth.handleCallback("rootline://auth/callback?code=duplicate&state=one"),
    ]);
    expect(maxCallbacksInFlight).toBe(1);
    expect(auth.snapshot().user).toEqual(expect.objectContaining({ sub: "alice" }));
    expect(auth.snapshot().error).toMatch(/already consumed/);
  });

  test("surfaces vault/startup and browser launch failures without leaving the offline UI loading", async () => {
    const manager = {
      getUser: vi.fn(async () => { throw new Error("OS credential unavailable"); }),
      signinRedirect: vi.fn(async () => { throw new Error("system browser unavailable"); }),
      signinRedirectCallback: vi.fn(), revokeTokens: vi.fn(), removeUser: vi.fn(),
    };
    const auth = new DesktopAuthController(config, manager as never);
    await expect(auth.initialize()).rejects.toThrow(/credential unavailable/);
    expect(auth.snapshot()).toEqual(expect.objectContaining({ loading: false, user: null, error: "OS credential unavailable" }));
    await expect(auth.signIn()).rejects.toThrow(/browser unavailable/);
    expect(auth.snapshot()).toEqual(expect.objectContaining({ loading: false, user: null, error: "system browser unavailable" }));
  });

  test("cleans a partial listener registration before retrying initialization", async () => {
    const firstDeepLinkUnlisten = vi.fn();
    const secondDeepLinkUnlisten = vi.fn();
    const singleInstanceUnlisten = vi.fn();
    tauriMocks.onOpenUrl
      .mockResolvedValueOnce(firstDeepLinkUnlisten)
      .mockResolvedValueOnce(secondDeepLinkUnlisten);
    tauriMocks.listen
      .mockRejectedValueOnce(new Error("listener unavailable"))
      .mockResolvedValueOnce(singleInstanceUnlisten);
    const manager = {
      getUser: vi.fn(async () => null), signinRedirect: vi.fn(),
      signinRedirectCallback: vi.fn(), revokeTokens: vi.fn(), removeUser: vi.fn(),
    };
    const auth = new DesktopAuthController(config, manager as never);
    await expect(auth.initialize()).rejects.toThrow(/listener unavailable/);
    expect(firstDeepLinkUnlisten).toHaveBeenCalledTimes(1);
    await auth.initialize();
    expect(tauriMocks.onOpenUrl).toHaveBeenCalledTimes(2);
    expect(tauriMocks.listen).toHaveBeenCalledTimes(2);
    auth.dispose();
    expect(secondDeepLinkUnlisten).toHaveBeenCalledTimes(1);
    expect(singleInstanceUnlisten).toHaveBeenCalledTimes(1);
  });

  test("commits account consent before scheduling best-effort hosted synchronization", async () => {
    const storedUser = {
      profile: { sub: "alice", permissions: ["rootline:profiles:sync"] },
      access_token: "access", expired: false,
    };
    const manager = {
      getUser: vi.fn(async () => storedUser), signinRedirect: vi.fn(),
      signinRedirectCallback: vi.fn(), revokeTokens: vi.fn(), removeUser: vi.fn(),
    };
    let releaseSync!: () => void;
    const pendingSync = new Promise<void>((resolve) => { releaseSync = resolve; });
    tauriMocks.invoke.mockImplementation(async (command: string) => {
      if (command === "sync_hosted_profiles") await pendingSync;
      return {};
    });
    const auth = new DesktopAuthController(config, manager as never);
    await auth.initialize();
    await auth.resolveAccountClaim(true);
    expect(tauriMocks.invoke).toHaveBeenCalledWith("claim_hosted_account", { subject: "alice", uploadExisting: true });
    expect(auth.snapshot().accountClaimRequired).toBeFalsy();
    expect(tauriMocks.invoke).toHaveBeenCalledWith("sync_hosted_profiles", expect.anything());
    releaseSync();
  });
});
