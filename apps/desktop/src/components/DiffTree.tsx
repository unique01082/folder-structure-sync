import { memo, useDeferredValue, useMemo, useRef, useState } from "react";

interface DiffTreeProps {
  entries: readonly string[];
  selected: ReadonlySet<string>;
  onSelectionChange: (selection: Set<string>) => void;
  labels?: {
    search: string;
    all: string;
    selected: string;
    clear: string;
    selectAll: string;
    expand: string;
    collapse: string;
  };
}

const ROW_HEIGHT = 38;
const VIEWPORT_HEIGHT = 456;
const OVERSCAN = 8;

const defaultLabels = {
  search: "Search folders",
  all: "All",
  selected: "Selected",
  clear: "Clear selection",
  selectAll: "Select all",
  expand: "Expand",
  collapse: "Collapse",
};

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

export const DiffTree = memo(function DiffTree({ entries, selected, onSelectionChange, labels = defaultLabels }: DiffTreeProps) {
  const [query, setQuery] = useState("");
  const deferredQuery = useDeferredValue(query.trim().toLocaleLowerCase());
  const [filter, setFilter] = useState<"all" | "selected">("all");
  const parents = useMemo(() => parentPaths(entries), [entries]);
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set(parents));
  const [scrollTop, setScrollTop] = useState(0);
  const viewport = useRef<HTMLDivElement>(null);

  const visible = useMemo(() => entries.filter((entry) => {
    if (filter === "selected" && !selected.has(entry)) return false;
    if (deferredQuery && !entry.toLocaleLowerCase().includes(deferredQuery)) return false;
    return visibleUnderExpansion(entry, expanded, parents);
  }), [deferredQuery, entries, expanded, filter, parents, selected]);

  const start = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN);
  const end = Math.min(visible.length, Math.ceil((scrollTop + VIEWPORT_HEIGHT) / ROW_HEIGHT) + OVERSCAN);
  const windowed = visible.slice(start, end);

  const toggleSelection = (entry: string): void => {
    const descendants = entries.filter((candidate) => candidate === entry || candidate.startsWith(`${entry}/`));
    const next = new Set(selected);
    const shouldSelect = descendants.some((candidate) => !next.has(candidate));
    for (const descendant of descendants) {
      if (shouldSelect) next.add(descendant);
      else next.delete(descendant);
    }
    onSelectionChange(next);
  };

  const toggleExpanded = (entry: string): void => {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(entry)) next.delete(entry);
      else next.add(entry);
      return next;
    });
  };

  return (
    <section className="diff-tree" aria-label="Folder differences">
      <div className="tree-tools">
        <label className="search-field">
          <span className="sr-only">{labels.search}</span>
          <svg aria-hidden="true" viewBox="0 0 24 24"><circle cx="10.5" cy="10.5" r="6.5"/><path d="m15.5 15.5 5 5"/></svg>
          <input
            type="search"
            aria-label={labels.search}
            placeholder={labels.search}
            value={query}
            onChange={(event) => { setQuery(event.currentTarget.value); setScrollTop(0); }}
          />
        </label>
        <div className="segmented" aria-label="Folder filter">
          <button type="button" aria-pressed={filter === "all"} onClick={() => setFilter("all")}>{labels.all}</button>
          <button type="button" aria-pressed={filter === "selected"} onClick={() => setFilter("selected")}>{labels.selected}</button>
        </div>
        <button className="quiet-button" type="button" onClick={() => onSelectionChange(new Set())}>{labels.clear}</button>
        <button className="quiet-button" type="button" onClick={() => onSelectionChange(new Set(entries))}>{labels.selectAll}</button>
      </div>
      <div className="tree-summary" aria-live="polite">
        <span>{visible.length.toLocaleString()} folders</span>
        <span>{selected.size.toLocaleString()} selected</span>
      </div>
      <div
        ref={viewport}
        className="tree-viewport"
        role="tree"
        aria-label="Missing folders"
        aria-rowcount={visible.length}
        tabIndex={0}
        onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)}
      >
        <div className="tree-spacer" role="presentation" style={{ height: `${visible.length * ROW_HEIGHT}px` }}>
          {windowed.map((entry, offset) => {
            const index = start + offset;
            const isParent = parents.has(entry);
            const isExpanded = expanded.has(entry);
            return (
              <div
                className="tree-row"
                role="treeitem"
                aria-level={depthOf(entry)}
                aria-posinset={index + 1}
                aria-setsize={visible.length}
                aria-expanded={isParent ? isExpanded : undefined}
                key={entry}
                style={{ top: `${index * ROW_HEIGHT}px`, paddingInlineStart: `${14 + (depthOf(entry) - 1) * 22}px` }}
              >
                {isParent ? (
                  <button
                    type="button"
                    className="disclosure"
                    aria-label={`${isExpanded ? labels.collapse : labels.expand} ${entry}`}
                    onClick={() => toggleExpanded(entry)}
                  >
                    <span aria-hidden="true">{isExpanded ? "−" : "+"}</span>
                  </button>
                ) : <span className="branch" aria-hidden="true" />}
                <label className="tree-check">
                  <input type="checkbox" aria-label={entry} checked={selected.has(entry)} onChange={() => toggleSelection(entry)} />
                  <span className="folder-glyph" aria-hidden="true" />
                  <span className="path-label">{entry}</span>
                </label>
              </div>
            );
          })}
        </div>
      </div>
    </section>
  );
});
