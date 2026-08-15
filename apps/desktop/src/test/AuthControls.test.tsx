import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test, vi } from "vitest";

import { AuthControls } from "../components/AuthControls";
import type { AuthController, AuthSnapshot } from "../auth";

test("sign-out explicitly keeps or removes local synced profiles without rendering tokens", async () => {
  const user = userEvent.setup();
  const state: AuthSnapshot = { configured: true, loading: false, user: { sub: "alice", name: "Alice", permissions: ["rootline:profiles:sync"] }, dataVersion: 0 };
  const auth: AuthController = {
    snapshot: () => state,
    subscribe: (listener) => { listener(state); return () => undefined; },
    initialize: vi.fn(async () => undefined),
    signIn: vi.fn(async () => undefined),
    handleCallback: vi.fn(async () => undefined),
    signOut: vi.fn(async () => undefined),
    deleteAccountData: vi.fn(async () => undefined),
    resolveEpochReset: vi.fn(async () => undefined),
    resolveAccountClaim: vi.fn(async () => undefined),
    sync: vi.fn(async () => undefined),
    dispose: vi.fn(),
  };
  const view = render(<AuthControls auth={auth} />);
  expect(view.container.textContent).not.toMatch(/access_token|refresh_token|bearer/i);
  await user.click(screen.getByRole("button", { name: "Sign out" }));
  await user.click(screen.getByRole("button", { name: "Keep local profiles" }));
  expect(auth.signOut).toHaveBeenCalledWith(false);
  await user.click(screen.getByRole("button", { name: "Sign out" }));
  await user.click(screen.getByRole("button", { name: "Remove local profiles" }));
  expect(auth.signOut).toHaveBeenCalledWith(true);

  await user.click(screen.getByRole("button", { name: "Delete hosted data" }));
  expect(screen.getByRole("dialog", { name: "Delete hosted data options" })).toHaveTextContent(/epoch will rotate/i);
  await user.click(screen.getByRole("button", { name: "Keep local profiles" }));
  expect(auth.deleteAccountData).toHaveBeenCalledWith(false);

  await user.click(screen.getByRole("button", { name: "Delete hosted data" }));
  await user.click(screen.getByRole("button", { name: "Remove local profiles" }));
  expect(auth.deleteAccountData).toHaveBeenCalledWith(true);
});

test("requires an explicit keep-or-remove decision after an epoch reset", async () => {
  const user = userEvent.setup();
  const state: AuthSnapshot = {
    configured: true, loading: false, dataVersion: 0, epochResetRequired: true,
    user: { sub: "alice", permissions: ["rootline:profiles:sync"] },
  };
  const auth: AuthController = {
    snapshot: () => state,
    subscribe: (listener) => { listener(state); return () => undefined; },
    initialize: vi.fn(async () => undefined), signIn: vi.fn(async () => undefined),
    handleCallback: vi.fn(async () => undefined), signOut: vi.fn(async () => undefined),
    deleteAccountData: vi.fn(async () => undefined), resolveEpochReset: vi.fn(async () => undefined), resolveAccountClaim: vi.fn(async () => undefined),
    sync: vi.fn(async () => undefined), dispose: vi.fn(),
  };
  render(<AuthControls auth={auth} />);
  expect(screen.getByRole("button", { name: "Sync now" })).toBeDisabled();
  await user.click(screen.getByRole("button", { name: "Review reset" }));
  expect(screen.getByRole("dialog", { name: "Hosted reset options" })).toHaveTextContent(/stale queued changes will be discarded/i);
  await user.click(screen.getByRole("button", { name: "Keep local profiles" }));
  expect(auth.resolveEpochReset).toHaveBeenCalledWith(false);
});

test("explains that accepting an existing epoch keeps explicitly consented device profiles queued", async () => {
  const user = userEvent.setup();
  const state = {
    configured: true, loading: false, dataVersion: 0, epochResetRequired: true,
    epochResetPreservesConsentedOutbox: true,
    user: { sub: "device-two", permissions: ["rootline:profiles:sync"] },
  } as AuthSnapshot & { epochResetPreservesConsentedOutbox: boolean };
  const auth = {
    snapshot: () => state,
    subscribe: (listener: (snapshot: AuthSnapshot) => void) => { listener(state); return () => undefined; },
    initialize: vi.fn(async () => undefined), signIn: vi.fn(async () => undefined),
    handleCallback: vi.fn(async () => undefined), signOut: vi.fn(async () => undefined),
    deleteAccountData: vi.fn(async () => undefined), resolveEpochReset: vi.fn(async () => undefined),
    resolveAccountClaim: vi.fn(async () => undefined), sync: vi.fn(async () => undefined), dispose: vi.fn(),
  } satisfies AuthController;
  render(<AuthControls auth={auth} />);
  await user.click(screen.getByRole("button", { name: "Review reset" }));
  expect(screen.getByRole("dialog", { name: "Hosted reset options" }))
    .toHaveTextContent(/explicitly consented.*remain queued.*uploaded/i);
});

test("requires explicit consent before existing absolute-path profiles are claimed by an account", async () => {
  const user = userEvent.setup();
  const state: AuthSnapshot = {
    configured: true, loading: false, dataVersion: 0, accountClaimRequired: true,
    user: { sub: "alice", permissions: ["rootline:profiles:sync"] },
  };
  const auth = {
    snapshot: () => state,
    subscribe: (listener: (snapshot: AuthSnapshot) => void) => { listener(state); return () => undefined; },
    initialize: vi.fn(async () => undefined), signIn: vi.fn(async () => undefined),
    handleCallback: vi.fn(async () => undefined), signOut: vi.fn(async () => undefined),
    deleteAccountData: vi.fn(async () => undefined), resolveEpochReset: vi.fn(async () => undefined),
    resolveAccountClaim: vi.fn(async () => undefined), sync: vi.fn(async () => undefined), dispose: vi.fn(),
  } satisfies AuthController;
  render(<AuthControls auth={auth} />);
  expect(screen.getByRole("button", { name: "Sync now" })).toBeDisabled();
  await user.click(screen.getByRole("button", { name: "Review local profiles" }));
  expect(screen.getByRole("dialog", { name: "Local profile upload options" })).toHaveTextContent(/absolute paths/i);
  await user.click(screen.getByRole("button", { name: "Keep local only" }));
  expect(auth.resolveAccountClaim).toHaveBeenCalledWith(false);
});
