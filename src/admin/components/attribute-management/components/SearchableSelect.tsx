import { TrianglesMini, XMarkMini } from "@medusajs/icons";
import { Input } from "@medusajs/ui";
import { useEffect, useMemo, useRef, useState } from "react";

type Item = { id: string; label: string };

type SearchableSelectProps = {
  items: Item[];
  value: string;
  onChange: (id: string) => void;
  placeholder?: string;
  disabled?: boolean;
  /** Texto tipeado sin seleccionar — para flujos "crear si no existe". */
  onQueryChange?: (query: string) => void;
};

/** Distancia de edición acotada — alcanza para typos de 1-2 letras. */
function editDistance(a: string, b: string, max: number): number {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev: number[] = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const row: number[] = [i];
    let rowMin = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a.charAt(i - 1) === b.charAt(j - 1) ? 0 : 1;
      const cell = Math.min(
        (prev[j] ?? max + 1) + 1,
        (row[j - 1] ?? max + 1) + 1,
        (prev[j - 1] ?? max + 1) + cost
      );
      row.push(cell);
      rowMin = Math.min(rowMin, cell);
    }
    prev = row;
    if (rowMin > max) return max + 1;
  }
  return prev[b.length] ?? max + 1;
}

function isSubsequence(query: string, target: string): boolean {
  let qi = 0;
  for (let ti = 0; ti < target.length && qi < query.length; ti++) {
    if (target[ti] === query[qi]) qi++;
  }
  return qi === query.length;
}

/**
 * Ranking: substring (mejor) → palabra que empieza igual → subsecuencia →
 * typo (distancia ≤2 contra alguna palabra, sólo con 4+ letras tipeadas).
 * Devuelve null si no matchea por ninguna vía.
 */
function scoreItem(query: string, label: string): number | null {
  const q = query.toLowerCase().trim();
  const l = label.toLowerCase();
  if (!q) return 0;
  const idx = l.indexOf(q);
  if (idx >= 0) return idx === 0 ? 0 : 1;
  const words = l.split(/[\s/()-]+/).filter(Boolean);
  if (words.some((w) => w.startsWith(q))) return 2;
  if (isSubsequence(q, l.replace(/\s+/g, ""))) return 3;
  if (q.length >= 4 && words.some((w) => editDistance(q, w, 2) <= 2)) return 4;
  return null;
}

/**
 * Combobox con búsqueda tolerante a typos para reemplazar los <Select> del
 * modal de atributos ("strp" encuentra "Strip Width"; "chanels" encuentra
 * "Channels"). Sin dependencias nuevas — input + lista posicionada.
 */
export const SearchableSelect = ({
  items,
  value,
  onChange,
  placeholder,
  disabled,
  onQueryChange,
}: SearchableSelectProps) => {
  const [open, setOpen] = useState(false);
  const [query, setQueryState] = useState("");
  const [highlight, setHighlight] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);

  const selected = items.find((i) => i.id === value) ?? null;

  const setQuery = (q: string) => {
    setQueryState(q);
    onQueryChange?.(q);
  };

  // Si el padre limpia el valor (p.ej. tras Add), limpiar el texto también.
  useEffect(() => {
    if (!value) setQuery("");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);

  const filtered = useMemo(() => {
    const scored = items
      .map((item) => ({ item, score: scoreItem(query, item.label) }))
      .filter((s): s is { item: Item; score: number } => s.score !== null);
    scored.sort(
      (a, b) => a.score - b.score || a.item.label.localeCompare(b.item.label)
    );
    return scored.map((s) => s.item);
  }, [items, query]);

  useEffect(() => setHighlight(0), [query, open]);

  // Cerrar al click afuera.
  useEffect(() => {
    if (!open) return;
    const onDocMouseDown = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDocMouseDown);
    return () => document.removeEventListener("mousedown", onDocMouseDown);
  }, [open]);

  const pick = (item: Item) => {
    onChange(item.id);
    setQuery("");
    setOpen(false);
  };

  return (
    <div ref={rootRef} className="relative">
      <div className="relative">
        <Input
          value={open ? query : (selected?.label ?? "")}
          placeholder={selected?.label ?? placeholder ?? "Search..."}
          disabled={disabled}
          onFocus={() => setOpen(true)}
          onChange={(e) => {
            setQuery(e.target.value);
            if (!open) setOpen(true);
          }}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") {
              e.preventDefault();
              setHighlight((h) => Math.min(h + 1, filtered.length - 1));
            } else if (e.key === "ArrowUp") {
              e.preventDefault();
              setHighlight((h) => Math.max(h - 1, 0));
            } else if (e.key === "Enter") {
              e.preventDefault();
              const item = filtered[highlight];
              if (item) pick(item);
            } else if (e.key === "Escape") {
              setOpen(false);
            }
          }}
          className="pr-8"
        />
        <span className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-ui-fg-muted">
          <TrianglesMini />
        </span>
        {selected && !disabled && !open && (
          <button
            type="button"
            aria-label="Clear selection"
            onClick={() => onChange("")}
            className="absolute right-7 top-1/2 -translate-y-1/2 rounded p-0.5 text-ui-fg-muted hover:text-ui-fg-base"
          >
            <XMarkMini />
          </button>
        )}
      </div>

      {open && !disabled && (
        <div className="absolute z-50 mt-1 max-h-64 w-full overflow-y-auto rounded-lg border border-ui-border-base bg-ui-bg-base shadow-elevation-flyout">
          {filtered.length === 0 ? (
            <div className="px-3 py-2 text-sm text-ui-fg-muted">No matches</div>
          ) : (
            filtered.map((item, i) => (
              <button
                key={item.id}
                type="button"
                // onMouseDown para ganarle al blur del input.
                onMouseDown={(e) => {
                  e.preventDefault();
                  pick(item);
                }}
                onMouseEnter={() => setHighlight(i)}
                className={`block w-full px-3 py-2 text-left text-sm text-ui-fg-base ${
                  i === highlight ? "bg-ui-bg-base-hover" : ""
                } ${item.id === value ? "font-semibold" : ""}`}
              >
                {item.label}
              </button>
            ))
          )}
        </div>
      )}
    </div>
  );
};
