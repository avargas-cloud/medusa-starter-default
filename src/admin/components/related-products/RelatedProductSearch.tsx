import { MagnifyingGlass } from "@medusajs/icons";
import { Input, Text } from "@medusajs/ui";
import { useEffect, useRef, useState } from "react";

import type { MeiliProduct } from "../../lib/meili-types";

const DEBOUNCE_MS = 300;

interface RelatedProductSearchProps {
  excludeIds: string[];
  disabled: boolean;
  onPick: (hit: MeiliProduct) => void;
}

export const RelatedProductSearch = ({
  excludeIds,
  disabled,
  onPick,
}: RelatedProductSearchProps) => {
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<MeiliProduct[]>([]);
  const [searching, setSearching] = useState(false);
  const [open, setOpen] = useState(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    const trimmed = query.trim();
    if (!trimmed) {
      setHits([]);
      setSearching(false);
      return;
    }
    setSearching(true);
    debounceRef.current = setTimeout(async () => {
      try {
        const res = await fetch(`/admin/search/products`, {
          method: "POST",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ q: trimmed, limit: 8, offset: 0 }),
        });
        if (!res.ok) throw new Error("Search failed");
        const data = await res.json();
        setHits((data.hits as MeiliProduct[]) ?? []);
        setOpen(true);
      } catch {
        setHits([]);
      } finally {
        setSearching(false);
      }
    }, DEBOUNCE_MS);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [query]);

  useEffect(() => {
    const onClickOutside = (e: MouseEvent) => {
      if (!containerRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onClickOutside);
    return () => document.removeEventListener("mousedown", onClickOutside);
  }, []);

  const excluded = new Set(excludeIds);
  const results = hits.filter((h) => !excluded.has(h.id));

  return (
    <div ref={containerRef} className="relative">
      <Input
        type="search"
        placeholder={
          disabled
            ? "Maximum 8 — remove one to add another"
            : "Search products to add…"
        }
        value={query}
        disabled={disabled}
        onChange={(e) => setQuery(e.target.value)}
        onFocus={() => hits.length > 0 && setOpen(true)}
      />
      {open && !disabled && query.trim() && (
        <div className="absolute z-10 mt-1 max-h-72 w-full overflow-y-auto rounded border border-ui-border-base bg-ui-bg-base shadow-elevation-flyout">
          {searching ? (
            <div className="px-3 py-2">
              <Text size="small" className="text-ui-fg-subtle">
                Searching…
              </Text>
            </div>
          ) : results.length === 0 ? (
            <div className="px-3 py-2">
              <Text size="small" className="text-ui-fg-subtle">
                No matches
              </Text>
            </div>
          ) : (
            results.map((hit) => (
              <button
                key={hit.id}
                type="button"
                className="flex w-full items-center gap-3 px-3 py-2 text-left hover:bg-ui-bg-base-hover"
                onClick={() => {
                  onPick(hit);
                  setQuery("");
                  setHits([]);
                  setOpen(false);
                }}
              >
                {hit.thumbnail ? (
                  <img
                    src={hit.thumbnail}
                    alt={hit.title}
                    className="h-8 w-8 shrink-0 rounded object-cover"
                  />
                ) : (
                  <div className="h-8 w-8 shrink-0 rounded bg-ui-bg-subtle" />
                )}
                <div className="min-w-0 flex-1">
                  <Text size="small" weight="plus" className="truncate">
                    {hit.title}
                  </Text>
                  <Text size="xsmall" className="truncate text-ui-fg-subtle">
                    {hit.handle}
                  </Text>
                </div>
                <MagnifyingGlass className="shrink-0 text-ui-fg-muted" />
              </button>
            ))
          )}
        </div>
      )}
    </div>
  );
};
