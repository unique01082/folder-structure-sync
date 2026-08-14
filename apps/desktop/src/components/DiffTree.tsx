import { memo, useDeferredValue, useEffect, useMemo, useRef, useState } from "react";

import { copy } from "../i18n";

export interface DiffTreeLabels {
  search: string;
  all: string;
  selected: string;
  clear: string;
  selectAll: string;
  folderDifferences: string;
  folderFilter: string;
  missingFolders: string;
  visibleCount: (count: number) => string;
  selectedCount: (count: number) => string;
}

interface DiffTreeProps {
  entries: readonly string[];
  selected: ReadonlySet<string>;
  onSelectionChange: (selection: Set<string>) => void;
  labels?: DiffTreeLabels;
}

const ROW_HEIGHT = 38;
const VIEWPORT_HEIGHT = 456;
const OVERSCAN = 8;

function depthOf(path: string): number {
  return path.split("/").length;
}

function parentPaths(entries: readonly string[]): Set<string> {
  const parents = new Set<string>();
  const entrySet = new Set(entries);
  for (const entry of entries) {
    const parts = entry.split("/");
    for (let depth = 1; depth < parts.length; depth += 1) {
      const parent = parts.slice(0, depth).join("/");
      if (entrySet.has(parent)) parents.add(parent);
    }
  }
  return parents;
}

function visibleUnderExpansion(entry: string, expanded: ReadonlySet<string>, parents: ReadonlySet<string>): boolean {
  const parts = entry.split("/");
  for (let depth = 1; depth < parts.length; depth += 1) {
    const parent = parts.slice(0, depth).join("/");
    if (parents.has(parent) && !expanded.has(parent)) return false;
  }
  return true;
}

function closeOverParents(entries: readonly string[], candidates: ReadonlySet<string>): Set<string> {
  const entrySet = new Set(entries);
  const closed = new Set<string>();
  for (const candidate of candidates) {
    if (!entrySet.has(candidate)) continue;
    const parts = candidate.split("/");
    for (let depth = 1; depth <= parts.length; depth += 1) {
      const path = parts.slice(0, depth).join("/");
      if (entrySet.has(path)) closed.add(path);
    }
  }
  return closed;
}

export const DiffTree = memo(function DiffTree({ entries, selected, onSelectionChange, labels = copy.en.tree }: DiffTreeProps) {
  const [query, setQuery] = useState("");
  const deferredQuery = useDeferredValue(query.trim().toLocaleLowerCase());
  const [filter, setFilter] = useState<"all" | "selected">("all");
  const parents = useMemo(() => parentPaths(entries), [entries]);
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set(parents));
  const [scrollTop, setScrollTop] = useState(0);
  const [activeEntry, setActiveEntry] = useState(entries[0] ?? "");
  const viewport = useRef<HTMLDivElement>(null);
  const itemRefs = useRef(new Map<string, HTMLDivElement>());
  const shouldFocusActive = useRef(false);

  const visible = useMemo(() => entries.filter((entry) => {
    if (filter === "selected" && !selected.has(entry)) return false;
    if (deferredQuery && !entry.toLocaleLowerCase().includes(deferredQuery)) return false;
    return visibleUnderExpansion(entry, expanded, parents);
  }), [deferredQuery, entries, expanded, filter, parents, selected]);

  useEffect(() => {
    if (!visible.includes(activeEntry)) setActiveEntry(visible[0] ?? "");
  }, [activeEntry, visible]);

  useEffect(() => {
    if (!shouldFocusActive.current) return;
    shouldFocusActive.current = false;
    itemRefs.current.get(activeEntry)?.focus();
  }, [activeEntry, scrollTop]);

  const start = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN);
  const end = Math.min(visible.length, Math.ceil((scrollTop + VIEWPORT_HEIGHT) / ROW_HEIGHT) + OVERSCAN);
  const windowed = visible.slice(start, end);

  const focusEntry = (entry: string): void => {
    const index = visible.indexOf(entry);
    if (index < 0) return;
    const nextTop = index * ROW_HEIGHT;
    if (nextTop < scrollTop || nextTop + ROW_HEIGHT > scrollTop + VIEWPORT_HEIGHT) {
      const top = Math.max(0, nextTop - ROW_HEIGHT);
      if (viewport.current) viewport.current.scrollTop = top;
      setScrollTop(top);
    }
    shouldFocusActive.current = true;
    setActiveEntry(entry);
  };

  const toggleSelection = (entry: string): void => {
    const descendants = entries.filter((candidate) => candidate === entry || candidate.startsWith(`${entry}/`));
    const next = new Set(selected);
    const shouldSelect = descendants.some((candidate) => !next.has(candidate));
    for (const descendant of descendants) {
      if (shouldSelect) next.add(descendant);
      else next.delete(descendant);
    }
    onSelectionChange(closeOverParents(entries, next));
  };

  const toggleExpanded = (entry: string, force?: boolean): void => {
    setExpanded((current) => {
      const next = new Set(current);
      const shouldExpand = force ?? !next.has(entry);
      if (shouldExpand) next.add(entry);
      else next.delete(entry);
      return next;
    });
  };

  const onTreeKeyDown = (event: React.KeyboardEvent<HTMLDivElement>, entry: string): void => {
    const index = visible.indexOf(entry);
    if (index < 0) return;
    if (event.key === "ArrowDown") focusEntry(visible[Math.min(visible.length - 1, index + 1)]!);
    else if (event.key === "ArrowUp") focusEntry(visible[Math.max(0, index - 1)]!);
    else if (event.key === "Home") focusEntry(visible[0]!);
    else if (event.key === "End") focusEntry(visible[visible.length - 1]!);
    else if (event.key === "ArrowRight" && parents.has(entry)) {
      if (!expanded.has(entry)) toggleExpanded(entry, true);
      else {
        const child = visible.find((candidate) => candidate.startsWith(`${entry}/`) && depthOf(candidate) === depthOf(entry) + 1);
        if (child) focusEntry(child);
      }
    } else if (event.key === "ArrowLeft") {
      if (parents.has(entry) && expanded.has(entry)) toggleExpanded(entry, false);
      else {
        const parts = entry.split("/");
        parts.pop();
        const parent = parts.join("/");
        if (parent) focusEntry(parent);
      }
    } else if (event.key === " " || event.key === "Enter") toggleSelection(entry);
    else return;
    event.preventDefault();
  };

  return (
    <section className="diff-tree" aria-label={labels.folderDifferences}>
      <div className="tree-tools">
        <label className="search-field">
          <span className="sr-only">{labels.search}</span>
          <svg aria-hidden="true" viewBox="0 0 24 24"><circle cx="10.5" cy="10.5" r="6.5"/><path d="m15.5 15.5 5 5"/></svg>
          <input type="search" aria-label={labels.search} placeholder={labels.search} value={query} onChange={(event) => { setQuery(event.currentTarget.value); setScrollTop(0); }} />
        </label>
        <div className="segmented" role="group" aria-label={labels.folderFilter}>
          <button type="button" aria-pressed={filter === "all"} onClick={() => setFilter("all")}>{labels.all}</button>
          <button type="button" aria-pressed={filter === "selected"} onClick={() => setFilter("selected")}>{labels.selected}</button>
        </div>
        <button className="quiet-button" type="button" onClick={() => onSelectionChange(new Set())}>{labels.clear}</button>
        <button className="quiet-button" type="button" onClick={() => onSelectionChange(new Set(entries))}>{labels.selectAll}</button>
      </div>
      <div className="tree-summary" aria-live="polite">
        <span>{labels.visibleCount(visible.length)}</span>
        <span>{labels.selectedCount(selected.size)}</span>
      </div>
      <div ref={viewport} className="tree-viewport" role="tree" aria-label={labels.missingFolders} aria-multiselectable="true" onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)}>
        <div className="tree-spacer" role="presentation" style={{ height: `${visible.length * ROW_HEIGHT}px` }}>
          {windowed.map((entry, offset) => {
            const index = start + offset;
            const isParent = parents.has(entry);
            const isExpanded = expanded.has(entry);
            const isSelected = selected.has(entry);
            return (
              <div
                ref={(node) => { if (node) itemRefs.current.set(entry, node); else itemRefs.current.delete(entry); }}
                className="tree-row"
                role="treeitem"
                aria-label={entry}
                aria-level={depthOf(entry)}
                aria-selected={isSelected}
                aria-expanded={isParent ? isExpanded : undefined}
                tabIndex={activeEntry === entry ? 0 : -1}
                key={entry}
                onClick={() => { setActiveEntry(entry); toggleSelection(entry); }}
                onFocus={() => setActiveEntry(entry)}
                onKeyDown={(event) => onTreeKeyDown(event, entry)}
                style={{ top: `${index * ROW_HEIGHT}px`, paddingInlineStart: `${14 + (depthOf(entry) - 1) * 22}px` }}
              >
                <span className={isParent ? "disclosure" : "branch"} aria-hidden="true" onClick={isParent ? (event) => { event.stopPropagation(); toggleExpanded(entry); } : undefined}>{isParent ? (isExpanded ? "−" : "+") : null}</span>
                <span className="selection-box" aria-hidden="true">{isSelected ? "✓" : ""}</span>
                <span className="folder-glyph" aria-hidden="true" />
                <span className="path-label">{entry}</span>
              </div>
            );
          })}
        </div>
      </div>
    </section>
  );
});
