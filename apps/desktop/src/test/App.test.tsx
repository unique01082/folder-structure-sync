import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import axe from "axe-core";
import { describe, expect, test, vi } from "vitest";

import { App } from "../App";
import { DiffTree } from "../components/DiffTree";
import type { NativeGateway, ScanPlan } from "../native";
import type { AuthController, AuthSnapshot, ProfileSyncCoordinator } from "../auth";

const plan: ScanPlan = {
  operationId: "scan-1",
  sourceRoot: "/projects/source",
  targetRoot: "/projects/target",
  sourceFingerprint: "source-fp",
  targetFingerprint: "target-fp",
  targetCaseSensitive: false,
  planFingerprint: "plan-fp",
  missing: ["docs", "docs/api", "src", "src/components"],
  diffEntries: [
    { relativePath: "docs", status: "missing" },
    { relativePath: "docs/api", status: "missing" },
    { relativePath: "existing", status: "exists" },
    { relativePath: "private", status: "excluded" },
    { relativePath: "locked", status: "unreadable" },
    { relativePath: "src", status: "missing" },
    { relativePath: "src/components", status: "missing" },
  ],
  skippedLinks: [],
};

function gateway(overrides: Partial<NativeGateway> = {}): NativeGateway {
  return {
    chooseFolder: vi.fn(async ({ role }) => role === "source" ? "/projects/source" : "/projects/target"),
    inspectProfileRoots: vi.fn(async () => ({ sourceAvailable: true, targetAvailable: true })),
    scan: vi.fn(async () => plan),
    apply: vi.fn(async () => ({
      runId: "run-1",
      startedAt: "2026-08-15T00:00:00Z",
      finishedAt: "2026-08-15T00:00:01Z",
      cancelled: false,
      directories: [
        { relativePath: "docs", status: "created" as const },
        { relativePath: "docs/api", status: "created" as const },
      ],
    })),
    cancel: vi.fn(async () => undefined),
    listProfiles: vi.fn(async () => []),
    saveProfile: vi.fn(async (profile) => profile),
    deleteProfile: vi.fn(async () => undefined),
    ...overrides,
  };
}

describe("Rootline desktop workflow", () => {
  test("moves from choosing roots through scan, review, and apply results", async () => {
    const user = userEvent.setup();
    const native = gateway();
    render(<App gateway={native} />);

    expect(screen.getByRole("heading", { name: "Choose two roots" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Choose source folder" }));
    await user.click(screen.getByRole("button", { name: "Choose target folder" }));
    expect(screen.getByText("/projects/source")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Scan differences" }));
    const reviewHeading = await screen.findByRole("heading", { name: "Review 4 missing folders" });
    expect(reviewHeading).toHaveFocus();
    await user.click(screen.getByRole("button", { name: "Clear selection" }));
    await user.click(screen.getByRole("treeitem", { name: "docs/api" }));
    expect(screen.getByRole("button", { name: "Create selected folders" })).toHaveTextContent("2");
    await user.click(screen.getByRole("button", { name: "Create selected folders" }));

    const resultHeading = await screen.findByRole("heading", { name: "2 folders created" });
    expect(resultHeading).toHaveFocus();
    expect(native.apply).toHaveBeenCalledWith(expect.objectContaining({ selected: ["docs", "docs/api"] }));
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.getByRole("button", { name: "Scan differences" })).toHaveFocus());
  });

  test("shows actionable loading, empty, failure, and rebind states", async () => {
    const user = userEvent.setup();
    let resolveScan: ((value: ScanPlan) => void) | undefined;
    const pending = new Promise<ScanPlan>((resolve) => { resolveScan = resolve; });
    const native = gateway({ scan: vi.fn(() => pending) });
    const view = render(<App gateway={native} />);
    await user.click(screen.getByRole("button", { name: "Choose source folder" }));
    await user.click(screen.getByRole("button", { name: "Choose target folder" }));
    await user.click(screen.getByRole("button", { name: "Scan differences" }));
    expect(screen.getByRole("status")).toHaveTextContent("Tracing folder structure");
    await act(async () => resolveScan?.({ ...plan, missing: [] }));
    expect(await screen.findByText("The target already has this structure.")).toBeInTheDocument();

    view.unmount();
    const failing = gateway({ scan: vi.fn(async () => { throw { code: "SOURCE_NOT_FOUND", message: "gone" }; }) });
    render(<App gateway={failing} initialProfile={{
      id: "p1", name: "Archive", sourcePath: "/missing", targetPath: "/target",
      exclusions: [], createdAt: "2026-08-15T00:00:00Z", updatedAt: "2026-08-15T00:00:00Z",
    }} />);
    await user.click(screen.getByRole("button", { name: "Scan differences" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Choose a new source folder");
    expect(screen.getByRole("button", { name: "Rebind source" })).toBeInTheDocument();
  });

  test("marks unavailable saved roots for rebind as soon as a profile is selected", async () => {
    const user = userEvent.setup();
    const profile = {
      id: "detached", name: "Detached", sourcePath: "/missing/source", targetPath: "/missing/target",
      exclusions: [], createdAt: "x", updatedAt: "x",
    };
    const inspectProfileRoots = vi.fn(async () => ({ sourceAvailable: false, targetAvailable: false }));
    const native = gateway({
      listProfiles: vi.fn(async () => [profile]),
      inspectProfileRoots,
    } as Partial<NativeGateway>);
    render(<App gateway={native} />);

    await user.click(await screen.findByRole("option", { name: "Detached" }));

    expect(await screen.findByRole("button", { name: "Rebind source" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Rebind target" })).toBeInTheDocument();
    expect(inspectProfileRoots).toHaveBeenCalledWith({ sourcePath: profile.sourcePath, targetPath: profile.targetPath });
    expect(native.scan).not.toHaveBeenCalled();
  });

  test("supports keyboard profile navigation, restores focus, Vietnamese copy, and has no serious axe violations", async () => {
    const user = userEvent.setup();
    const native = gateway({
      listProfiles: vi.fn(async () => [
        { id: "one", name: "One", sourcePath: "/one", targetPath: "/target-one", exclusions: [], createdAt: "x", updatedAt: "x" },
        { id: "two", name: "Two", sourcePath: "/two", targetPath: "/target-two", exclusions: [], createdAt: "x", updatedAt: "x" },
      ]),
    });
    const { container } = render(<App gateway={native} />);
    const first = await screen.findByRole("option", { name: "One" });
    first.focus();
    await user.keyboard("{ArrowDown}{Enter}");
    expect(screen.getByText("/two")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Tiếng Việt" }));
    expect(document.documentElement.lang).toBe("vi");
    expect(screen.getByRole("heading", { name: "Chọn hai thư mục gốc" })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Quét khác biệt" }));
    await user.click(await screen.findByRole("button", { name: "Tạo các thư mục đã chọn" }));
    expect((await screen.findAllByText("đã tạo")).length).toBeGreaterThan(0);
    expect(screen.getByText("đã tồn tại")).toBeInTheDocument();
    expect(screen.getByText("thất bại")).toBeInTheDocument();

    const results = await axe.run(container);
    expect(results.violations.filter((violation) => violation.impact === "critical" || violation.impact === "serious")).toEqual([]);
  });

  test("focuses progress and choose transitions and localizes native stale errors", async () => {
    const user = userEvent.setup();
    let rejectScan: ((reason: unknown) => void) | undefined;
    const scanPending = new Promise<ScanPlan>((_resolve, reject) => { rejectScan = reject; });
    const native = gateway({
      scan: vi.fn(() => scanPending),
      cancel: vi.fn(async () => rejectScan?.({ code: "CANCELLED", message: "raw cancelled" })),
    });
    const first = render(<App gateway={native} initialProfile={{
      id: "p", name: "Pair", sourcePath: "/projects/source", targetPath: "/projects/target",
      exclusions: [], createdAt: "x", updatedAt: "x",
    }} />);
    await user.click(screen.getByRole("button", { name: "Scan differences" }));
    expect(screen.getByRole("heading", { name: "Tracing folder structure…" })).toHaveFocus();
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Scan differences" })).toHaveFocus());
    expect(document.body).not.toHaveFocus();
    first.unmount();

    const stale = gateway({ apply: vi.fn(async () => { throw { code: "STALE_PLAN", message: "raw Rust stale" }; }) });
    const view = render(<App gateway={stale} initialProfile={{
      id: "p", name: "Pair", sourcePath: "/projects/source", targetPath: "/projects/target",
      exclusions: [], createdAt: "x", updatedAt: "x",
    }} />);
    await user.click(screen.getByRole("button", { name: "Tiếng Việt" }));
    await user.click(screen.getByRole("button", { name: "Quét khác biệt" }));
    await user.click(await screen.findByRole("button", { name: "Tạo các thư mục đã chọn" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Thư mục đã thay đổi");
    expect(screen.queryByText("raw Rust stale")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Chọn cặp khác" }));
    expect(screen.getByRole("heading", { name: "Chọn hai thư mục gốc" })).toHaveFocus();
    view.unmount();
  });

  test("renders localized per-path results, failure details, and cancelled runs", async () => {
    const user = userEvent.setup();
    const native = gateway({
      apply: vi.fn(async () => ({
        runId: "partial", startedAt: "x", finishedAt: "y", cancelled: true,
        directories: [
          { relativePath: "docs", status: "created" as const },
          { relativePath: "existing", status: "already-exists" as const },
          { relativePath: "blocked", status: "failed" as const, error: "Permission denied" },
        ],
      })),
    });
    render(<App gateway={native} initialProfile={{
      id: "p", name: "Pair", sourcePath: "/projects/source", targetPath: "/projects/target",
      exclusions: [], createdAt: "x", updatedAt: "x",
    }} />);
    await user.click(screen.getByRole("button", { name: "Tiếng Việt" }));
    await user.click(screen.getByRole("button", { name: "Quét khác biệt" }));
    await user.click(await screen.findByRole("button", { name: "Tạo các thư mục đã chọn" }));
    expect(await screen.findByRole("heading", { name: "Đã hủy sau khi tạo 1 thư mục" })).toBeInTheDocument();
    expect(screen.getByText("docs").closest("li")).toHaveTextContent("đã tạo");
    expect(screen.getByText("existing").closest("li")).toHaveTextContent("đã tồn tại");
    expect(screen.getByText("blocked").closest("li")).toHaveTextContent("thất bại");
    expect(screen.getByText("Permission denied")).toBeInTheDocument();
    expect(screen.getByText("Kiểm tra quyền truy cập rồi chạy lại.")).toBeInTheDocument();
  });

  test("has zero axe violations while Review is mounted", async () => {
    const user = userEvent.setup();
    const { container } = render(<App gateway={gateway()} initialProfile={{
      id: "p", name: "Pair", sourcePath: "/projects/source", targetPath: "/projects/target",
      exclusions: [], createdAt: "x", updatedAt: "x",
    }} />);
    await user.click(screen.getByRole("button", { name: "Scan differences" }));
    await screen.findByRole("heading", { name: "Review 4 missing folders" });
    expect(screen.getByRole("tree", { name: "Folder differences" })).toHaveAttribute("aria-multiselectable", "true");
    expect(screen.getByRole("treeitem", { name: "existing" })).toHaveTextContent("Exists");
    expect(screen.getByRole("treeitem", { name: "private" })).toHaveTextContent("Excluded");
    expect(screen.getByRole("treeitem", { name: "locked" })).toHaveTextContent("Unreadable");
    expect(screen.getByRole("button", { name: "Select all missing" })).toBeInTheDocument();
    const results = await axe.run(container);
    expect(results.violations).toEqual([]);
  });

  test("reconciles visible profiles after hosted sync or destructive cleanup commits", async () => {
    const user = userEvent.setup();
    const profile = { id: "remote", name: "Remote", sourcePath: "/private/path", targetPath: "/target", exclusions: [], createdAt: "x", updatedAt: "x" };
    const listProfiles = vi.fn().mockResolvedValueOnce([profile]).mockResolvedValueOnce([]);
    const listeners = new Set<(snapshot: AuthSnapshot) => void>();
    let state: AuthSnapshot = { configured: true, loading: false, dataVersion: 0, user: { sub: "alice", permissions: ["rootline:profiles:sync"] } };
    const auth: AuthController = {
      snapshot: () => state,
      subscribe: (listener) => { listeners.add(listener); listener(state); return () => listeners.delete(listener); },
      initialize: vi.fn(async () => undefined), signIn: vi.fn(async () => undefined),
      cancelSignIn: vi.fn(async () => undefined),
      handleCallback: vi.fn(async () => undefined), signOut: vi.fn(async () => undefined),
      deleteAccountData: vi.fn(async () => undefined), resolveEpochReset: vi.fn(async () => undefined), resolveAccountClaim: vi.fn(async () => undefined),
      sync: vi.fn(async () => undefined), dispose: vi.fn(),
    };
    render(<App gateway={gateway({ listProfiles })} auth={auth} />);
    await user.click(await screen.findByRole("option", { name: "Remote" }));
    expect(screen.getByText("/private/path")).toBeInTheDocument();
    state = { ...state, dataVersion: 1 };
    listeners.forEach((listener) => listener(state));
    await waitFor(() => expect(screen.queryByRole("option", { name: "Remote" })).not.toBeInTheDocument());
    expect(screen.queryByText("/private/path")).not.toBeInTheDocument();
  });

  test("enforces shared profile limits in the UI with localized errors before native persistence", async () => {
    const user = userEvent.setup();
    const native = gateway();
    const exactCodePoints = (count: number) => "✈️".repeat(Math.floor(count / 2)) + (count % 2 ? "x" : "");
    const boundary = {
      id: "limits",
      name: exactCodePoints(80),
      sourcePath: exactCodePoints(4096),
      targetPath: exactCodePoints(4096),
      exclusions: Array.from({ length: 100 }, () => exactCodePoints(256)),
      createdAt: "x",
      updatedAt: "x",
    };
    const view = render(<App gateway={native} initialProfile={boundary} />);
    const name = screen.getByRole("textbox", { name: "Profile name" });
    expect(name).not.toHaveAttribute("minlength");
    expect(name).not.toHaveAttribute("maxlength");
    expect(name).toBeRequired();

    await user.click(screen.getByRole("button", { name: "Save profile" }));
    expect(native.saveProfile).toHaveBeenCalledWith(expect.objectContaining({
      name: boundary.name,
      sourcePath: boundary.sourcePath,
      targetPath: boundary.targetPath,
      exclusions: boundary.exclusions,
    }));
    vi.mocked(native.saveProfile).mockClear();

    fireEvent.change(name, { target: { value: exactCodePoints(81) } });
    await user.click(screen.getByRole("button", { name: "Save profile" }));
    expect(screen.getByRole("alert")).toHaveTextContent("Profile name must contain 1–80 characters.");
    expect(native.saveProfile).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "Tiếng Việt" }));
    await user.click(screen.getByRole("button", { name: "Lưu hồ sơ" }));
    expect(screen.getByRole("alert")).toHaveTextContent("Tên hồ sơ phải có từ 1–80 ký tự.");
    expect(native.saveProfile).not.toHaveBeenCalled();

    view.unmount();
    for (const invalidProfile of [
      { ...boundary, id: "path-over", name: "Valid", sourcePath: exactCodePoints(4097) },
      { ...boundary, id: "pattern-over", name: "Valid", exclusions: [exactCodePoints(257)] },
      { ...boundary, id: "array-over", name: "Valid", exclusions: Array.from({ length: 101 }, () => "x") },
    ]) {
      const invalidView = render(<App gateway={native} initialProfile={invalidProfile} />);
      await user.click(screen.getByRole("button", { name: "Save profile" }));
      expect(screen.getByRole("alert")).toHaveTextContent("This profile exceeds Rootline’s limits.");
      expect(native.saveProfile).not.toHaveBeenCalled();
      invalidView.unmount();
    }
  });

  test("localizes native profile validation failures without persisting UI state", async () => {
    const user = userEvent.setup();
    const native = gateway({
      saveProfile: vi.fn(async () => { throw { code: "VALIDATION_FAILED", message: "raw native limit" }; }),
    });
    render(<App gateway={native} initialProfile={{
      id: "limits", name: "Valid", sourcePath: "/source", targetPath: "/target",
      exclusions: [], createdAt: "x", updatedAt: "x",
    }} />);
    await user.click(screen.getByRole("button", { name: "Tiếng Việt" }));
    await user.click(screen.getByRole("button", { name: "Lưu hồ sơ" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Hồ sơ vượt quá giới hạn cho phép");
    expect(screen.queryByText("raw native limit")).not.toBeInTheDocument();
  });

  test("deletes a profile through a keyboard-accessible localized confirmation and queues sync", async () => {
    const user = userEvent.setup();
    const profile = {
      id: "delete-me", name: "Archive", sourcePath: "/archive", targetPath: "/backup",
      exclusions: [], createdAt: "x", updatedAt: "x",
    };
    const native = gateway({ listProfiles: vi.fn(async () => [profile]) });
    const coordinator = { profileEdited: vi.fn() } as unknown as ProfileSyncCoordinator;
    render(<App gateway={native} syncCoordinator={coordinator} />);

    const option = await screen.findByRole("option", { name: "Archive" });
    await user.click(option);
    option.focus();
    await user.keyboard("{Delete}");
    const englishDialog = screen.getByRole("dialog", { name: "Delete profile Archive?" });
    expect(englishDialog).toHaveTextContent("Run history is preserved");
    expect(screen.getByRole("button", { name: "Cancel profile deletion" })).toHaveFocus();
    await user.keyboard("{Escape}");
    await waitFor(() => expect(option).toHaveFocus());

    await user.click(screen.getByRole("button", { name: "Tiếng Việt" }));
    await user.click(screen.getByRole("button", { name: "Xóa hồ sơ Archive" }));
    const vietnameseDialog = screen.getByRole("dialog", { name: "Xóa hồ sơ Archive?" });
    expect(vietnameseDialog).toHaveTextContent("Lịch sử lượt chạy vẫn được giữ lại");
    await user.click(screen.getByRole("button", { name: "Xác nhận xóa hồ sơ" }));

    await waitFor(() => expect(native.deleteProfile).toHaveBeenCalledWith("delete-me"));
    expect(screen.queryByRole("option", { name: "Archive" })).not.toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Tên hồ sơ" })).toHaveValue("");
    expect(coordinator.profileEdited).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: "Hồ sơ mới" })).toHaveFocus();
  });
});

describe("DiffTree virtualization", () => {
  test("renders a bounded window for a 50,000-folder fixture and keeps subtree selection", async () => {
    const user = userEvent.setup();
    const paths = Array.from({ length: 50_000 }, (_, index) => `root/group-${Math.floor(index / 100)}/folder-${index}`);
    const entries = paths.map((relativePath) => ({ relativePath, status: "missing" as const }));
    const onSelectionChange = vi.fn();
    const { container } = render(
      <DiffTree entries={entries} selected={new Set(paths)} onSelectionChange={onSelectionChange} />,
    );

    expect(screen.getByRole("tree")).not.toHaveAttribute("aria-rowcount");
    expect(container.querySelectorAll('[role="treeitem"]').length).toBeLessThan(80);
    await user.type(screen.getByRole("searchbox", { name: "Search folders" }), "folder-49999");
    expect(await screen.findByRole("treeitem", { name: paths[49_999]! })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Clear selection" }));
    expect(onSelectionChange).toHaveBeenLastCalledWith(new Set());
  });

  test("uses named treeitems with roving keyboard navigation and parent dependency selection", async () => {
    const user = userEvent.setup();
    const entries = ["docs", "docs/api", "docs/api/v2", "src"].map((relativePath) => ({ relativePath, status: "missing" as const }));
    const onSelectionChange = vi.fn();
    const view = render(<DiffTree entries={entries} selected={new Set()} onSelectionChange={onSelectionChange} />);
    const docs = screen.getByRole("treeitem", { name: "docs" });
    const api = screen.getByRole("treeitem", { name: "docs/api" });
    expect(screen.getByRole("tree")).not.toHaveAttribute("aria-rowcount");
    expect(docs).toHaveAttribute("tabindex", "0");
    expect(view.container.querySelector('[role="treeitem"] button, [role="treeitem"] input')).toBeNull();
    docs.focus();
    await user.keyboard("{ArrowDown}");
    expect(api).toHaveFocus();
    await user.keyboard(" ");
    expect(onSelectionChange).toHaveBeenLastCalledWith(new Set(["docs", "docs/api", "docs/api/v2"]));
    await user.keyboard("{ArrowLeft}");
    expect(api).toHaveFocus();
    await user.keyboard("{ArrowLeft}");
    expect(docs).toHaveFocus();
    await user.keyboard("{End}");
    expect(screen.getByRole("treeitem", { name: "src" })).toHaveFocus();
  });

  test("provides explicit localized controls to collapse and expand the whole tree", async () => {
    const user = userEvent.setup();
    const entries = ["docs", "docs/api", "src"].map((relativePath) => ({ relativePath, status: "missing" as const }));
    render(<DiffTree entries={entries} selected={new Set()} onSelectionChange={vi.fn()} />);

    await user.click(screen.getByRole("button", { name: "Collapse all" }));
    expect(screen.queryByRole("treeitem", { name: "docs/api" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Expand all" }));
    expect(screen.getByRole("treeitem", { name: "docs/api" })).toBeInTheDocument();
  });
});
