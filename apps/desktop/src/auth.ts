import type { UnlistenFn } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { appDataDir, join } from "@tauri-apps/api/path";
import { getCurrent, onOpenUrl } from "@tauri-apps/plugin-deep-link";
import { openUrl } from "@tauri-apps/plugin-opener";
import { Stronghold, type Store } from "@tauri-apps/plugin-stronghold";
import {
  UserManager,
  WebStorageStateStore,
  type AsyncStorage,
  type INavigator,
  type IWindow,
  type NavigateParams,
  type NavigateResponse,
  type UserManagerSettings,
} from "oidc-client-ts";

export const OIDC_SCOPE = "openid profile email permissions offline_access";
export const OIDC_REDIRECT_URI = "rootline://auth/callback";
export const OIDC_BROWSER_FLOW_TIMEOUT_MS = 5 * 60 * 1000;

export interface OidcConfiguration {
  authority: string;
  clientId: string;
  apiUrl: string;
  redirectUri: typeof OIDC_REDIRECT_URI;
  scope: typeof OIDC_SCOPE;
}

export interface AuthViewUser {
  sub: string;
  name?: string;
  email?: string;
  permissions: string[];
}

export interface AuthSnapshot {
  configured: boolean;
  loading: boolean;
  user: AuthViewUser | null;
  dataVersion: number;
  accountClaimRequired?: boolean;
  epochResetRequired?: boolean;
  epochResetPreservesConsentedOutbox?: boolean;
  signInPending?: boolean;
  quarantinedMutations?: number;
  error?: string;
}

export interface AuthController {
  snapshot(): AuthSnapshot;
  subscribe(listener: (snapshot: AuthSnapshot) => void): () => void;
  initialize(): Promise<void>;
  signIn(): Promise<void>;
  cancelSignIn(): Promise<void>;
  handleCallback(url: string): Promise<void>;
  signOut(removeLocalProfiles: boolean): Promise<void>;
  deleteAccountData(removeLocalProfiles: boolean): Promise<void>;
  resolveEpochReset(removeLocalProfiles: boolean): Promise<void>;
  resolveAccountClaim(uploadExisting: boolean): Promise<void>;
  sync(): Promise<void>;
  dispose(): void;
}

function withoutAuthError(snapshot: AuthSnapshot): AuthSnapshot {
  const next = { ...snapshot };
  delete next.error;
  return next;
}

interface Environment {
  VITE_AUTHENTIK_ISSUER?: string;
  VITE_AUTHENTIK_CLIENT_ID?: string;
  VITE_ROOTLINE_SYNC_API?: string;
}

export function readOidcConfiguration(environment: Environment): OidcConfiguration | null {
  const values = [environment.VITE_AUTHENTIK_ISSUER, environment.VITE_AUTHENTIK_CLIENT_ID, environment.VITE_ROOTLINE_SYNC_API];
  if (values.every((value) => !value)) return null;
  if (!environment.VITE_AUTHENTIK_ISSUER) throw new Error("VITE_AUTHENTIK_ISSUER is required when hosted sync is configured.");
  if (!environment.VITE_AUTHENTIK_CLIENT_ID) throw new Error("VITE_AUTHENTIK_CLIENT_ID is required when hosted sync is configured.");
  if (!environment.VITE_ROOTLINE_SYNC_API) throw new Error("VITE_ROOTLINE_SYNC_API is required when hosted sync is configured.");
  const authority = new URL(environment.VITE_AUTHENTIK_ISSUER);
  const api = new URL(environment.VITE_ROOTLINE_SYNC_API);
  if (authority.protocol !== "https:" || api.protocol !== "https:") throw new Error("Hosted authentication and sync endpoints must use HTTPS.");
  return { authority: authority.toString(), clientId: environment.VITE_AUTHENTIK_CLIENT_ID, apiUrl: api.toString().replace(/\/$/, ""), redirectUri: OIDC_REDIRECT_URI, scope: OIDC_SCOPE };
}

function callbackError(): Error {
  return new Error("AUTH_CALLBACK_INVALID: Rootline rejected an unexpected authentication callback.");
}

export function validateCallbackUrl(rawUrl: string, expectedState?: string): URL {
  let url: URL;
  try { url = new URL(rawUrl); } catch { throw callbackError(); }
  if (url.protocol !== "rootline:" || url.hostname !== "auth" || url.pathname !== "/callback" || url.hash) throw callbackError();
  if (url.searchParams.getAll("code").length !== 1 || url.searchParams.getAll("state").length !== 1) throw callbackError();
  if (!url.searchParams.get("code") || !url.searchParams.get("state")) throw callbackError();
  if (expectedState !== undefined && url.searchParams.get("state") !== expectedState) throw callbackError();
  return url;
}

interface ProjectableUser {
  profile: { sub?: unknown; name?: unknown; email?: unknown; permissions?: unknown };
  expired?: boolean | undefined;
  access_token?: unknown;
  id_token?: unknown;
  refresh_token?: unknown;
}

export function projectUser(user: ProjectableUser): AuthViewUser | null {
  if (user.expired || typeof user.profile.sub !== "string") return null;
  const permissions = Array.isArray(user.profile.permissions)
    ? user.profile.permissions.filter((value): value is string => typeof value === "string")
    : [];
  return {
    sub: user.profile.sub,
    ...(typeof user.profile.name === "string" ? { name: user.profile.name } : {}),
    ...(typeof user.profile.email === "string" ? { email: user.profile.email } : {}),
    permissions,
  };
}

export class StrongholdAsyncStorage implements AsyncStorage {
  private readonly encoder = new TextEncoder();
  private readonly decoder = new TextDecoder();
  private readonly opened = this.open();
  private static readonly INDEX = "__rootline_oidc_keys";

  get length(): Promise<number> { return this.keys().then((keys) => keys.length); }
  private async open(): Promise<{ stronghold: Stronghold; store: Store }> {
    const password = await invoke<string>("auth_vault_password");
    const stronghold = await Stronghold.load(await join(await appDataDir(), "rootline-auth.stronghold"), password);
    let client;
    try { client = await stronghold.loadClient("rootline-oidc"); }
    catch { client = await stronghold.createClient("rootline-oidc"); }
    return { stronghold, store: client.getStore() };
  }
  async clear(): Promise<void> {
    const { stronghold, store } = await this.opened;
    for (const key of await this.keys()) await store.remove(key);
    await store.remove(StrongholdAsyncStorage.INDEX);
    await stronghold.save();
  }
  async getItem(key: string): Promise<string | null> {
    const value = await (await this.opened).store.get(key);
    return value ? this.decoder.decode(value) : null;
  }
  key(index: number): Promise<string | null> { return this.keys().then((keys) => keys[index] ?? null); }
  async removeItem(key: string): Promise<void> {
    const { stronghold, store } = await this.opened;
    await store.remove(key);
    await this.writeKeys((await this.keys()).filter((value) => value !== key));
    await stronghold.save();
  }
  async setItem(key: string, value: string): Promise<void> {
    const { stronghold, store } = await this.opened;
    await store.insert(key, Array.from(this.encoder.encode(value)));
    const keys = await this.keys();
    if (!keys.includes(key)) await this.writeKeys([...keys, key].sort());
    await stronghold.save();
  }
  private async writeKeys(keys: string[]): Promise<void> {
    await (await this.opened).store.insert(StrongholdAsyncStorage.INDEX, Array.from(this.encoder.encode(JSON.stringify(keys))));
  }
  private async keys(): Promise<string[]> {
    const value = await (await this.opened).store.get(StrongholdAsyncStorage.INDEX);
    if (!value) return [];
    const parsed: unknown = JSON.parse(this.decoder.decode(value));
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
  }
}

class SystemBrowserNavigator implements INavigator {
  prepare(): Promise<IWindow> {
    return Promise.resolve({
      navigate: async ({ url }: NavigateParams): Promise<NavigateResponse> => { await openUrl(url); return { url }; },
      close: () => undefined,
    });
  }
  callback(): Promise<void> { return Promise.resolve(); }
}

export function createOidcSettings(
  config: OidcConfiguration,
  stateStore: WebStorageStateStore,
  userStore: WebStorageStateStore,
): UserManagerSettings {
  return {
    authority: config.authority,
    client_id: config.clientId,
    redirect_uri: config.redirectUri,
    post_logout_redirect_uri: config.redirectUri,
    response_type: "code",
    disablePKCE: false,
    scope: config.scope,
    stateStore,
    userStore,
    automaticSilentRenew: true,
    revokeTokensOnSignout: true,
    loadUserInfo: true,
  };
}

export class DesktopAuthController implements AuthController {
  private current: AuthSnapshot = { configured: true, loading: true, user: null, dataVersion: 0 };
  private readonly listeners = new Set<(snapshot: AuthSnapshot) => void>();
  private readonly manager: UserManager;
  private unlisteners: UnlistenFn[] = [];
  private resetEpoch: string | undefined;
  private initialization = 0;
  private initialized = false;
  private initializationFlight: { generation: number; promise: Promise<void> } | undefined;
  private callbackQueue: Promise<void> = Promise.resolve();
  private readonly processedCallbackStates = new Set<string>();
  private signInTimer: ReturnType<typeof setTimeout> | undefined;
  private signInGeneration = 0;
  private signInStateCleanup: Promise<void> = Promise.resolve();

  constructor(private readonly config: OidcConfiguration, manager?: UserManager) {
    if (manager) {
      this.manager = manager;
    } else {
      const storage = new StrongholdAsyncStorage();
      const stateStore = new WebStorageStateStore({ prefix: "rootline.oidc.state.", store: storage });
      const userStore = new WebStorageStateStore({ prefix: "rootline.oidc.user.", store: storage });
      const settings = createOidcSettings(config, stateStore, userStore);
      this.manager = new UserManager(settings, new SystemBrowserNavigator());
    }
  }

  snapshot(): AuthSnapshot { return this.current; }
  subscribe(listener: (snapshot: AuthSnapshot) => void): () => void {
    this.listeners.add(listener);
    listener(this.current);
    return () => this.listeners.delete(listener);
  }
  private update(value: AuthSnapshot): void { this.current = value; this.listeners.forEach((listener) => listener(value)); }

  initialize(): Promise<void> {
    if (this.initialized) return Promise.resolve();
    if (this.initializationFlight?.generation === this.initialization) return this.initializationFlight.promise;
    const generation = ++this.initialization;
    const promise = this.initializeOnce(generation).catch((error: unknown) => {
      if (generation === this.initialization) {
        this.update({
          ...this.current,
          loading: false,
          error: error instanceof Error ? error.message : "Secure account storage is unavailable.",
        });
      }
      throw error;
    }).finally(() => {
      if (this.initializationFlight?.generation === generation) this.initializationFlight = undefined;
    });
    this.initializationFlight = { generation, promise };
    return promise;
  }

  private async initializeOnce(generation: number): Promise<void> {
    let deepLink: UnlistenFn | undefined;
    try {
      deepLink = await onOpenUrl((urls) => { for (const url of urls) void this.handleCallback(url); });
      if (generation !== this.initialization) return;
      for (const url of await getCurrent() ?? []) await this.handleCallback(url);
      if (generation !== this.initialization) return;
      const user = await this.manager.getUser();
      if (generation !== this.initialization) return;
      this.update({ configured: true, loading: false, user: user ? projectUser(user) : this.current.user, dataVersion: this.current.dataVersion });
      this.unlisteners.push(deepLink);
      deepLink = undefined;
      this.initialized = true;
    } finally {
      deepLink?.();
    }
  }

  async signIn(): Promise<void> {
    if (this.current.signInPending) await this.cancelSignIn();
    this.clearSignInTimer();
    const generation = ++this.signInGeneration;
    this.update({ ...withoutAuthError(this.current), loading: true, signInPending: false });
    try {
      await this.signInStateCleanup;
      if (generation !== this.signInGeneration) return;
      await this.manager.signinRedirect({ nonce: crypto.randomUUID() });
      if (generation !== this.signInGeneration) return;
      this.update({ ...withoutAuthError(this.current), loading: false, signInPending: true });
      this.signInTimer = setTimeout(() => {
        if (generation !== this.signInGeneration) return;
        this.signInGeneration += 1;
        this.signInTimer = undefined;
        this.update({ ...this.current, loading: false, signInPending: false, error: "AUTH_SIGNIN_TIMEOUT" });
        void this.queueSignInStateDiscard();
      }, OIDC_BROWSER_FLOW_TIMEOUT_MS);
    } catch (error) {
      if (generation === this.signInGeneration) {
        this.update({
          ...this.current,
          loading: false,
          signInPending: false,
          error: error instanceof Error ? error.message : "The system browser could not be opened.",
        });
      }
      throw error;
    }
  }

  private clearSignInTimer(): void {
    if (this.signInTimer) clearTimeout(this.signInTimer);
    this.signInTimer = undefined;
  }

  private async discardSignInState(): Promise<void> {
    try {
      const keys = await this.manager.settings.stateStore.getAllKeys();
      await Promise.all(keys.map((key) => this.manager.settings.stateStore.remove(key)));
    } catch {
      try { await this.manager.clearStaleState(); } catch { /* best-effort protocol-state cleanup */ }
    }
  }

  private queueSignInStateDiscard(): Promise<void> {
    this.signInStateCleanup = this.signInStateCleanup.then(() => this.discardSignInState());
    return this.signInStateCleanup;
  }

  async cancelSignIn(): Promise<void> {
    this.signInGeneration += 1;
    this.clearSignInTimer();
    this.update({ ...withoutAuthError(this.current), loading: false, signInPending: false });
    await this.queueSignInStateDiscard();
  }

  handleCallback(rawUrl: string): Promise<void> {
    const pending = this.callbackQueue.then(() => this.processCallback(rawUrl));
    this.callbackQueue = pending.catch(() => undefined);
    return pending;
  }

  private async processCallback(rawUrl: string): Promise<void> {
    const lifecycleGeneration = this.signInGeneration;
    try {
      const url = validateCallbackUrl(rawUrl);
      const state = url.searchParams.get("state")!;
      if (this.processedCallbackStates.has(state)) return;
      this.processedCallbackStates.add(state);
      const user = await this.manager.signinRedirectCallback(url.toString());
      if (lifecycleGeneration !== this.signInGeneration) {
        try { await this.manager.removeUser(); } catch { /* stale callbacks must never restore a session */ }
        return;
      }
      this.signInGeneration += 1;
      this.clearSignInTimer();
      this.update({ configured: true, loading: false, signInPending: false, user: projectUser(user), dataVersion: this.current.dataVersion });
      try { await this.sync(); } catch { /* sync() already surfaces reset-required; offline sign-in remains valid */ }
    } catch (error) {
      if (lifecycleGeneration !== this.signInGeneration) return;
      this.update({
        configured: true,
        loading: false,
        signInPending: false,
        user: this.current.user,
        dataVersion: this.current.dataVersion,
        error: error instanceof Error ? error.message : "Authentication failed.",
      });
    }
  }

  async signOut(removeLocalProfiles: boolean): Promise<void> {
    this.signInGeneration += 1;
    this.clearSignInTimer();
    try { await this.manager.revokeTokens(["access_token", "refresh_token"]); } catch { /* local sign-out must still complete offline */ }
    await this.manager.removeUser();
    await invoke("disconnect_hosted_account", { removeLocalProfiles });
    this.resetEpoch = undefined;
    this.update({ configured: true, loading: false, user: null, dataVersion: this.current.dataVersion + 1 });
  }

  async deleteAccountData(removeLocalProfiles: boolean): Promise<void> {
    const user = await this.manager.getUser();
    if (!user || user.expired || !user.access_token || typeof user.profile.sub !== "string") throw new Error("AUTH_REQUIRED");
    await invoke("delete_hosted_account_data", {
      apiUrl: this.config.apiUrl,
      accessToken: user.access_token,
      subject: user.profile.sub,
      removeLocalProfiles,
    });
    const next = { ...this.current, dataVersion: this.current.dataVersion + 1 };
    if (removeLocalProfiles) delete next.quarantinedMutations;
    this.update(next);
  }

  async resolveEpochReset(removeLocalProfiles: boolean): Promise<void> {
    const user = await this.manager.getUser();
    if (!user || user.expired || typeof user.profile.sub !== "string" || !this.resetEpoch) throw new Error("AUTH_REQUIRED");
    await invoke("accept_hosted_epoch", {
      subject: user.profile.sub,
      epoch: this.resetEpoch,
      removeLocalProfiles,
    });
    this.resetEpoch = undefined;
    this.update({
      configured: true,
      loading: false,
      user: projectUser(user),
      dataVersion: this.current.dataVersion + 1,
    });
  }

  async resolveAccountClaim(uploadExisting: boolean): Promise<void> {
    const user = await this.manager.getUser();
    if (!user || user.expired || typeof user.profile.sub !== "string") throw new Error("AUTH_REQUIRED");
    await invoke("claim_hosted_account", { subject: user.profile.sub, uploadExisting });
    this.update({
      configured: true,
      loading: false,
      user: projectUser(user),
      dataVersion: this.current.dataVersion + 1,
    });
    void this.sync().catch(() => undefined);
  }

  async sync(): Promise<void> {
    const user = await this.manager.getUser();
    if (!user || user.expired || !user.access_token || typeof user.profile.sub !== "string") return;
    try {
      const outcome = await invoke<{ quarantinedMutations?: unknown }>("sync_hosted_profiles", { apiUrl: this.config.apiUrl, accessToken: user.access_token, subject: user.profile.sub });
      const quarantinedMutations = typeof outcome?.quarantinedMutations === "number" && outcome.quarantinedMutations > 0
        ? outcome.quarantinedMutations
        : undefined;
      const next: AuthSnapshot = { ...this.current, dataVersion: this.current.dataVersion + 1 };
      if (quarantinedMutations === undefined) delete next.quarantinedMutations;
      else next.quarantinedMutations = quarantinedMutations;
      this.update(next);
    } catch (error) {
      const value = error as { code?: unknown; message?: unknown; details?: { epoch?: unknown; preservesConsentedOutbox?: unknown } };
      if (value?.code === "SYNC_EPOCH_RESET_REQUIRED" && typeof value.details?.epoch === "string") {
        this.resetEpoch = value.details.epoch;
        this.update({
          ...this.current,
          loading: false,
          epochResetRequired: true,
          epochResetPreservesConsentedOutbox: value.details.preservesConsentedOutbox === true,
          error: typeof value.message === "string" ? value.message : "Hosted profile data was reset.",
        });
      } else if (value?.code === "SYNC_ACCOUNT_CLAIM_REQUIRED") {
        this.update({
          ...this.current,
          loading: false,
          accountClaimRequired: true,
          error: "Choose whether this account may upload existing local profiles.",
        });
      }
      throw error;
    }
  }

  dispose(): void {
    this.signInGeneration += 1;
    this.clearSignInTimer();
    this.initialization += 1;
    this.initialized = false;
    this.initializationFlight = undefined;
    this.unlisteners.splice(0).forEach((unlisten) => unlisten());
  }
}

class LocalAuthController implements AuthController {
  private readonly value: AuthSnapshot = { configured: false, loading: false, user: null, dataVersion: 0 };
  snapshot() { return this.value; }
  subscribe(listener: (snapshot: AuthSnapshot) => void) { listener(this.value); return () => undefined; }
  initialize() { return Promise.resolve(); }
  signIn() { return Promise.resolve(); }
  cancelSignIn() { return Promise.resolve(); }
  handleCallback() { return Promise.resolve(); }
  signOut(removeLocalProfiles: boolean) { return removeLocalProfiles ? invoke<void>("clear_local_synced_data") : Promise.resolve(); }
  deleteAccountData(removeLocalProfiles: boolean) { return removeLocalProfiles ? invoke<void>("clear_local_synced_data") : Promise.resolve(); }
  resolveEpochReset(removeLocalProfiles: boolean) { return removeLocalProfiles ? invoke<void>("clear_local_synced_data") : Promise.resolve(); }
  resolveAccountClaim() { return Promise.resolve(); }
  sync() { return Promise.resolve(); }
  dispose() { /* nothing to release */ }
}

export function createDesktopAuth(environment: Environment = {
  VITE_AUTHENTIK_ISSUER: import.meta.env.VITE_AUTHENTIK_ISSUER,
  VITE_AUTHENTIK_CLIENT_ID: import.meta.env.VITE_AUTHENTIK_CLIENT_ID,
  VITE_ROOTLINE_SYNC_API: import.meta.env.VITE_ROOTLINE_SYNC_API,
}): AuthController {
  const config = readOidcConfiguration(environment);
  return config ? new DesktopAuthController(config) : new LocalAuthController();
}

export class ProfileSyncCoordinator {
  private timer: ReturnType<typeof setTimeout> | undefined;
  constructor(private readonly auth: AuthController, private readonly debounceMs = 750) {}
  private async safeSync(): Promise<void> { try { await this.auth.sync(); } catch { /* offline use remains unaffected */ } }
  start(): Promise<void> { return this.safeSync(); }
  signedIn(): Promise<void> { return this.safeSync(); }
  manual(): Promise<void> { return this.auth.sync(); }
  profileEdited(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => { this.timer = undefined; void this.safeSync(); }, this.debounceMs);
  }
}
