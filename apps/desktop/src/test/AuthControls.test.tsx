import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import axe from "axe-core";
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
    cancelSignIn: vi.fn(async () => undefined),
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
    cancelSignIn: vi.fn(async () => undefined),
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
    cancelSignIn: vi.fn(async () => undefined),
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
    cancelSignIn: vi.fn(async () => undefined),
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

test("fully localizes controls and provides a trapped, Escape-restoring Vietnamese dialog", async () => {
  const user = userEvent.setup();
  const state: AuthSnapshot = {
    configured: true, loading: false, dataVersion: 0,
    user: { sub: "alice", name: "Alice", permissions: ["rootline:profiles:sync"] },
  };
  const auth = {
    snapshot: () => state,
    subscribe: (listener: (snapshot: AuthSnapshot) => void) => { listener(state); return () => undefined; },
    initialize: vi.fn(async () => undefined), signIn: vi.fn(async () => undefined),
    cancelSignIn: vi.fn(async () => undefined), handleCallback: vi.fn(async () => undefined),
    signOut: vi.fn(async () => undefined), deleteAccountData: vi.fn(async () => undefined),
    resolveEpochReset: vi.fn(async () => undefined), resolveAccountClaim: vi.fn(async () => undefined),
    sync: vi.fn(async () => undefined), dispose: vi.fn(),
  } satisfies AuthController;
  const view = render(<AuthControls auth={auth} locale="vi" />);

  const trigger = screen.getByRole("button", { name: "Đăng xuất" });
  expect(screen.getByRole("button", { name: "Đồng bộ ngay" })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Xóa dữ liệu lưu trữ" })).toBeInTheDocument();
  expect(screen.queryByText("Sync now")).not.toBeInTheDocument();
  await user.click(trigger);
  const dialog = screen.getByRole("dialog", { name: "Tùy chọn đăng xuất" });
  expect(dialog).toHaveTextContent(/lịch sử lượt chạy vẫn được giữ lại/i);
  const cancel = screen.getByRole("button", { name: "Hủy" });
  expect(cancel).toHaveFocus();
  await user.keyboard("{Shift>}{Tab}{/Shift}");
  expect(screen.getByRole("button", { name: "Xóa hồ sơ cục bộ" })).toHaveFocus();
  await user.keyboard("{Escape}");
  expect(dialog).not.toBeInTheDocument();
  expect(trigger).toHaveFocus();
  expect((await axe.run(view.container)).violations).toEqual([]);
});

test("offers cancel and retry for a pending browser sign-in and explains quarantined changes", async () => {
  const user = userEvent.setup();
  const pending: AuthSnapshot = { configured: true, loading: false, signInPending: true, user: null, dataVersion: 0 };
  const auth = {
    snapshot: () => pending,
    subscribe: (listener: (snapshot: AuthSnapshot) => void) => { listener(pending); return () => undefined; },
    initialize: vi.fn(async () => undefined), signIn: vi.fn(async () => undefined),
    cancelSignIn: vi.fn(async () => undefined), handleCallback: vi.fn(async () => undefined),
    signOut: vi.fn(async () => undefined), deleteAccountData: vi.fn(async () => undefined),
    resolveEpochReset: vi.fn(async () => undefined), resolveAccountClaim: vi.fn(async () => undefined),
    sync: vi.fn(async () => undefined), dispose: vi.fn(),
  } satisfies AuthController;
  const view = render(<AuthControls auth={auth} locale="en" />);
  expect(screen.getByRole("status")).toHaveTextContent("Waiting for sign-in in your browser");
  await user.click(screen.getByRole("button", { name: "Cancel sign-in" }));
  await user.click(screen.getByRole("button", { name: "Try sign-in again" }));
  expect(auth.cancelSignIn).toHaveBeenCalledTimes(1);
  expect(auth.signIn).toHaveBeenCalledTimes(1);

  const synced = { ...pending, signInPending: false, user: { sub: "alice", permissions: [] }, quarantinedMutations: 2 } satisfies AuthSnapshot;
  view.rerender(<AuthControls auth={{
    ...auth,
    snapshot: () => synced,
    subscribe: (listener) => { listener(synced); return () => undefined; },
  }} locale="en" />);
  expect(screen.getByRole("status")).toHaveTextContent("2 local profile changes could not be uploaded");
  expect(screen.getByRole("status")).toHaveTextContent("Edit and save the affected profiles");
  expect(screen.getByRole("status")).toHaveTextContent("delete");
});
