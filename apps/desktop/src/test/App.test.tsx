import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import axe from "axe-core";
import { describe, expect, test, vi } from "vitest";

import { App } from "../App";
import { DiffTree } from "../components/DiffTree";
import type { NativeGateway, ScanPlan } from "../native";

const plan: ScanPlan = {
  operationId: "scan-1",
  sourceFingerprint: "source-fp",
  targetFingerprint: "target-fp",
  targetCaseSensitive: false,
  planFingerprint: "plan-fp",
  missing: ["docs", "docs/api", "src", "src/components"],
  skippedLinks: [],
};

function gateway(overrides: Partial<NativeGateway> = {}): NativeGateway {
  return {
    chooseFolder: vi.fn(async ({ role }) => role === "source" ? "/projects/source" : "/projects/target"),
    scan: vi.fn(async () => plan),
    apply: vi.fn(async () => ({
      runId: "run-1",
      startedAt: "2026-08-15T00:00:00Z",
      finishedAt: "2026-08-15T00:00:01Z",
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
    await user.click(screen.getByRole("checkbox", { name: "docs/api" }));
    await user.click(screen.getByRole("button", { name: "Create selected folders" }));

    const resultHeading = await screen.findByRole("heading", { name: "2 folders created" });
    expect(resultHeading).toHaveFocus();
    expect(native.apply).toHaveBeenCalledWith(expect.objectContaining({ selected: ["docs", "src", "src/components"] }));
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
    expect(screen.getByRole("heading", { name: "Chọn hai thư mục gốc" })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Quét khác biệt" }));
    await user.click(await screen.findByRole("button", { name: "Tạo các thư mục đã chọn" }));
    expect(await screen.findByText("đã tạo")).toBeInTheDocument();
    expect(screen.getByText("không đổi")).toBeInTheDocument();
    expect(screen.getByText("thất bại")).toBeInTheDocument();

    const results = await axe.run(container);
    expect(results.violations.filter((violation) => violation.impact === "critical" || violation.impact === "serious")).toEqual([]);
  });
});

describe("DiffTree virtualization", () => {
  test("renders a bounded window for a 50,000-folder fixture and keeps subtree selection", async () => {
    const user = userEvent.setup();
    const entries = Array.from({ length: 50_000 }, (_, index) => `root/group-${Math.floor(index / 100)}/folder-${index}`);
    const onSelectionChange = vi.fn();
    const { container } = render(
      <DiffTree entries={entries} selected={new Set(entries)} onSelectionChange={onSelectionChange} />,
    );

    expect(screen.getByRole("tree")).toHaveAttribute("aria-rowcount", "50000");
    expect(container.querySelectorAll('[role="treeitem"]').length).toBeLessThan(80);
    await user.type(screen.getByRole("searchbox", { name: "Search folders" }), "folder-49999");
    expect(await screen.findByRole("checkbox", { name: entries[49_999]! })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Clear selection" }));
    expect(onSelectionChange).toHaveBeenLastCalledWith(new Set());
  });
});
