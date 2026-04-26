import { defineRouteConfig } from "@medusajs/admin-sdk";
import {
  ArrowsPointingOut,
  CheckCircle,
  MagnifyingGlass,
  Plus,
  Trash,
  XMark,
} from "@medusajs/icons";
import {
  Badge,
  Button,
  Container,
  Heading,
  Input,
  Table,
  Text,
  toast,
} from "@medusajs/ui";
import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";

// ── Types ─────────────────────────────────────────────────────────────────────

type AlternativeRow = {
  primary_variant_id: string;
  sku: string;
  product_title: string;
  alt_count: number;
  inv_usa: number;
  inv_china: number;
  alt_inv_usa: number;
  abc_class: string | null;
  xyz_class: string | null;
};

type SearchResult = {
  id: string;
  sku: string;
  product_title: string;
  inv_usa: number;
};

// ── Helpers ───────────────────────────────────────────────────────────────────

const classBadgeColor = (
  cls: string | null
): "green" | "blue" | "orange" | "red" | "grey" => {
  if (!cls) return "grey";
  const c = cls.toUpperCase();
  if (c.startsWith("A")) return "green";
  if (c.startsWith("B")) return "blue";
  if (c.startsWith("C")) return "orange";
  return "grey";
};

const fmtQty = (n: number) => n.toLocaleString();

// ── Add Alternative to Existing Primary Modal ─────────────────────────────────

const AddAltModal = ({
  primary,
  onAdded,
  onClose,
}: {
  primary: AlternativeRow;
  onAdded: () => void;
  onClose: () => void;
}) => {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchResult[]>([]);
  const [searching, setSearching] = useState(false);
  const [adding, setAdding] = useState<string | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    if (query.length < 2) { setResults([]); return; }
    debounceRef.current = setTimeout(async () => {
      setSearching(true);
      try {
        const res = await fetch(
          `/admin/purchasing/variants/search?q=${encodeURIComponent(query)}&exclude=${encodeURIComponent(primary.primary_variant_id)}`,
          { credentials: "include" }
        );
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        setResults(data.variants ?? []);
      } catch {
        setResults([]);
      } finally {
        setSearching(false);
      }
    }, 300);
    return () => { if (debounceRef.current) clearTimeout(debounceRef.current); };
  }, [query, primary.primary_variant_id]);

  const handleAdd = async (altVariantId: string) => {
    setAdding(altVariantId);
    try {
      const res = await fetch("/admin/purchasing/alternatives", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          primary_variant_id: primary.primary_variant_id,
          alt_variant_id: altVariantId,
        }),
      });
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        throw new Error((d as { message?: string; error?: string }).message ?? `HTTP ${res.status}`);
      }
      toast.success("Alternative added");
      onAdded();
      setQuery("");
      setResults([]);
    } catch (e) {
      toast.error("Failed", { description: (e as Error).message });
    } finally {
      setAdding(null);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
      <div className="bg-ui-bg-base border border-ui-border-base rounded-xl shadow-xl w-[520px] max-h-[80vh] flex flex-col">
        <div className="flex items-start justify-between px-6 pt-5 pb-3">
          <div>
            <Heading level="h2" className="text-sm">Add Alternative</Heading>
            <Text className="text-ui-fg-subtle text-xs mt-0.5">
              Primary: <span className="font-mono font-medium">{primary.sku}</span>
            </Text>
          </div>
          <Button variant="transparent" size="small" onClick={onClose}>
            <XMark />
          </Button>
        </div>

        <div className="px-6 pb-3 border-b border-ui-border-base">
          <div className="relative">
            <MagnifyingGlass className="absolute left-3 top-1/2 -translate-y-1/2 text-ui-fg-muted" />
            <input
              ref={inputRef}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search SKU or product name…"
              className="w-full pl-9 pr-3 py-2 text-sm border border-ui-border-base rounded-lg bg-ui-bg-field focus:outline-none focus:ring-2 focus:ring-ui-border-interactive"
            />
          </div>
        </div>

        <div className="flex-1 overflow-y-auto px-6 py-3">
          {searching && (
            <Text className="text-ui-fg-subtle text-sm text-center py-4">Searching…</Text>
          )}
          {!searching && results.length === 0 && query.length >= 2 && (
            <Text className="text-ui-fg-subtle text-sm text-center py-4">No results</Text>
          )}
          {!searching && query.length < 2 && (
            <Text className="text-ui-fg-subtle text-sm text-center py-4">Type at least 2 characters to search</Text>
          )}
          {results.map((r) => (
            <div
              key={r.id}
              className="flex items-center justify-between py-2.5 border-b border-ui-border-base last:border-0"
            >
              <div>
                <span className="font-mono text-sm font-medium">{r.sku}</span>
                <p className="text-ui-fg-subtle text-xs">{r.product_title}</p>
              </div>
              <Button
                variant="secondary"
                size="small"
                isLoading={adding === r.id}
                onClick={() => handleAdd(r.id)}
              >
                Add as Alternative
              </Button>
            </div>
          ))}
        </div>

        <div className="px-6 py-3 border-t border-ui-border-base flex justify-end">
          <Button variant="secondary" size="small" onClick={onClose}>Close</Button>
        </div>
      </div>
    </div>
  );
};

// ── Add New Primary Modal (2-step) ────────────────────────────────────────────

type PendingAlt = { id: string; sku: string; product_title: string };

const AddPrimaryModal = ({
  onAdded,
  onClose,
}: {
  onAdded: () => void;
  onClose: () => void;
}) => {
  const [primary, setPrimary] = useState<SearchResult | null>(null);
  const [pendingAlts, setPendingAlts] = useState<PendingAlt[]>([]);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchResult[]>([]);
  const [searching, setSearching] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => { inputRef.current?.focus(); }, []);

  const blockedIds = useMemo(() => new Set([
    ...(primary ? [primary.id] : []),
    ...pendingAlts.map((a) => a.id),
  ]), [primary, pendingAlts]);

  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    if (query.length < 2) { setResults([]); return; }
    debounceRef.current = setTimeout(async () => {
      setSearching(true);
      try {
        const res = await fetch(
          `/admin/purchasing/variants/search?q=${encodeURIComponent(query)}&limit=20`,
          { credentials: "include" }
        );
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        setResults(data.variants ?? []);
      } catch {
        setResults([]);
      } finally {
        setSearching(false);
      }
    }, 300);
    return () => { if (debounceRef.current) clearTimeout(debounceRef.current); };
  }, [query]);

  function selectPrimary(v: SearchResult) {
    setPrimary(v);
    setQuery("");
    setResults([]);
    setError(null);
    setTimeout(() => inputRef.current?.focus(), 50);
  }

  function addAlt(v: SearchResult) {
    setPendingAlts((prev) => [...prev, { id: v.id, sku: v.sku, product_title: v.product_title }]);
    setQuery("");
    setResults([]);
    inputRef.current?.focus();
  }

  async function handleSave() {
    if (!primary || pendingAlts.length === 0) {
      setError("Add at least one alternative before saving.");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      for (const alt of pendingAlts) {
        const res = await fetch("/admin/purchasing/alternatives", {
          method: "POST",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ primary_variant_id: primary.id, alt_variant_id: alt.id }),
        });
        if (!res.ok) {
          const d = await res.json().catch(() => ({}));
          throw new Error((d as { message?: string; error?: string }).message ?? `HTTP ${res.status}`);
        }
      }
      toast.success("Primary added", { description: `${primary.sku} with ${pendingAlts.length} alternative(s)` });
      onAdded();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
      <div className="bg-ui-bg-base border border-ui-border-base rounded-xl shadow-xl w-[540px] max-h-[85vh] flex flex-col">
        <div className="flex items-start justify-between px-6 pt-5 pb-3 flex-shrink-0">
          <div>
            <Heading level="h2" className="text-sm">Add Primary Product</Heading>
            <Text className="text-ui-fg-subtle text-xs mt-0.5">
              {!primary ? "Step 1: Search and select the primary (main) variant" : "Step 2: Add one or more alternatives"}
            </Text>
          </div>
          <Button variant="transparent" size="small" onClick={onClose}>
            <XMark />
          </Button>
        </div>

        {/* Primary chip / search */}
        <div className="px-6 pb-3 border-b border-ui-border-base flex-shrink-0">
          {primary ? (
            <div className="flex items-center gap-2 px-3 py-2 border border-ui-border-base rounded-lg bg-ui-bg-field">
              <CheckCircle className="text-ui-fg-interactive flex-shrink-0" />
              <span className="font-mono text-sm font-medium">{primary.sku}</span>
              <span className="text-ui-fg-subtle text-xs truncate flex-1">{primary.product_title}</span>
              <Button
                variant="transparent"
                size="small"
                onClick={() => { setPrimary(null); setPendingAlts([]); setQuery(""); }}
              >
                <XMark />
              </Button>
            </div>
          ) : (
            <div className="relative">
              <MagnifyingGlass className="absolute left-3 top-1/2 -translate-y-1/2 text-ui-fg-muted" />
              <input
                ref={inputRef}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search primary SKU or product name…"
                className="w-full pl-9 pr-3 py-2 text-sm border border-ui-border-base rounded-lg bg-ui-bg-field focus:outline-none focus:ring-2 focus:ring-ui-border-interactive"
              />
            </div>
          )}
        </div>

        {/* Alternatives search — shown after primary selected */}
        {primary && (
          <div className="px-6 pt-3 pb-2 flex-shrink-0 flex flex-col gap-2">
            <div className="relative">
              <MagnifyingGlass className="absolute left-3 top-1/2 -translate-y-1/2 text-ui-fg-muted" />
              <input
                ref={inputRef}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search alternative SKU or product name…"
                className="w-full pl-9 pr-3 py-2 text-sm border border-ui-border-base rounded-lg bg-ui-bg-field focus:outline-none focus:ring-2 focus:ring-ui-border-interactive"
              />
            </div>
            {pendingAlts.length > 0 && (
              <div className="flex flex-col gap-1 max-h-[120px] overflow-y-auto">
                {pendingAlts.map((alt) => (
                  <div key={alt.id} className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-ui-bg-field border border-ui-border-base text-sm">
                    <span className="text-ui-fg-muted">→</span>
                    <span className="font-mono font-medium">{alt.sku}</span>
                    <span className="text-ui-fg-subtle truncate flex-1">{alt.product_title}</span>
                    <Button
                      variant="transparent"
                      size="small"
                      onClick={() => setPendingAlts((prev) => prev.filter((a) => a.id !== alt.id))}
                    >
                      <Trash />
                    </Button>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* Search results */}
        {(results.length > 0 || (searching && query.length >= 2)) && (
          <div className="px-6 pb-3 flex-shrink-0 overflow-y-auto max-h-[200px]">
            {searching ? (
              <Text className="text-ui-fg-subtle text-sm text-center py-3">Searching…</Text>
            ) : results.map((r) => {
              const blocked = blockedIds.has(r.id);
              return (
                <div
                  key={r.id}
                  className={`flex items-center justify-between py-2 border-b border-ui-border-base last:border-0 ${blocked ? "opacity-40" : "cursor-pointer hover:bg-ui-bg-base-hover rounded"}`}
                  onClick={() => { if (blocked) return; if (!primary) selectPrimary(r); else addAlt(r); }}
                >
                  <div>
                    <span className="font-mono text-sm font-medium">{r.sku}</span>
                    <p className="text-ui-fg-subtle text-xs">{r.product_title}</p>
                  </div>
                  {blocked
                    ? <Badge size="2xsmall" color="grey">Added</Badge>
                    : <Badge size="2xsmall" color="blue">{!primary ? "Select as Primary" : "Add as Alternative"}</Badge>
                  }
                </div>
              );
            })}
          </div>
        )}

        {error && (
          <div className="px-6 pb-2 flex-shrink-0">
            <Text className="text-ui-fg-error text-xs">{error}</Text>
          </div>
        )}

        <div className="px-6 py-3 border-t border-ui-border-base flex items-center justify-end gap-2 flex-shrink-0">
          <Button variant="secondary" size="small" onClick={onClose}>Cancel</Button>
          {primary && (
            <Button
              variant="primary"
              size="small"
              isLoading={saving}
              disabled={pendingAlts.length === 0}
              onClick={handleSave}
            >
              Save Primary
            </Button>
          )}
        </div>
      </div>
    </div>
  );
};

// ── Main Page ─────────────────────────────────────────────────────────────────

const PurchasingAlternativesPage = () => {
  const navigate = useNavigate();
  const [rows, setRows] = useState<AlternativeRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [showAddPrimary, setShowAddPrimary] = useState(false);
  const [addAltFor, setAddAltFor] = useState<AlternativeRow | null>(null);

  const fetchList = async () => {
    setLoading(true);
    try {
      const res = await fetch("/admin/purchasing/alternatives", {
        credentials: "include",
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setRows(data.alternatives ?? []);
    } catch (e) {
      toast.error("Failed to load alternatives", {
        description: (e as Error).message,
      });
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchList();
  }, []);

  const filtered = useMemo(() => {
    if (!search.trim()) return rows;
    const s = search.toLowerCase();
    return rows.filter(
      (r) =>
        r.sku.toLowerCase().includes(s) ||
        r.product_title.toLowerCase().includes(s)
    );
  }, [rows, search]);

  return (
    <div className="flex flex-col gap-4 p-6">
      <div className="flex items-start justify-between">
        <div>
          <Heading level="h1">Product Alternatives</Heading>
          <Text className="text-ui-fg-subtle mt-1">
            Alternative SKU relationships. Sales from alternatives are added to
            the primary product's demand; their inventory is deducted from order
            quantities.
          </Text>
        </div>
        <Button
          variant="primary"
          size="small"
          onClick={() => setShowAddPrimary(true)}
        >
          <Plus />
          Add Primary
        </Button>
      </div>

      <Container className="p-0">
        <div className="flex items-center gap-3 px-6 py-3 border-b border-ui-border-base">
          <Input
            placeholder="Search by SKU or product title…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="max-w-sm"
          />
          <Text className="text-ui-fg-subtle text-sm ml-auto">
            {filtered.length}{" "}
            {filtered.length === 1 ? "primary product" : "primary products"}
          </Text>
        </div>

        {loading && (
          <Text className="text-ui-fg-subtle py-6 px-6">Loading…</Text>
        )}
        {!loading && filtered.length === 0 && (
          <Text className="text-ui-fg-subtle py-6 px-6">
            No alternative relationships found.{" "}
            <button
              className="text-ui-fg-interactive underline"
              onClick={() => setShowAddPrimary(true)}
            >
              Add the first primary product.
            </button>
          </Text>
        )}
        {!loading && filtered.length > 0 && (
          <div className="max-h-[calc(100vh-280px)] overflow-y-auto">
            <Table>
              <Table.Header>
                <Table.Row>
                  <Table.HeaderCell>Primary SKU</Table.HeaderCell>
                  <Table.HeaderCell>Product</Table.HeaderCell>
                  <Table.HeaderCell className="text-right">
                    Alternatives
                  </Table.HeaderCell>
                  <Table.HeaderCell className="text-right">
                    Inv USA
                  </Table.HeaderCell>
                  <Table.HeaderCell className="text-right">
                    Alt Inv USA
                  </Table.HeaderCell>
                  <Table.HeaderCell className="text-right">
                    China WH
                  </Table.HeaderCell>
                  <Table.HeaderCell>Class</Table.HeaderCell>
                  <Table.HeaderCell />
                </Table.Row>
              </Table.Header>
              <Table.Body>
                {filtered.map((r) => (
                  <Table.Row
                    key={r.primary_variant_id}
                    className="cursor-pointer hover:bg-ui-bg-base-hover"
                    onClick={() =>
                      navigate(
                        `/purchasing-alternatives/${r.primary_variant_id}`
                      )
                    }
                  >
                    <Table.Cell>
                      <span className="font-mono text-sm font-medium">
                        {r.sku}
                      </span>
                    </Table.Cell>
                    <Table.Cell className="text-ui-fg-subtle max-w-xs truncate">
                      {r.product_title}
                    </Table.Cell>
                    <Table.Cell className="text-right">
                      <Badge color="blue" size="2xsmall">
                        {r.alt_count}
                      </Badge>
                    </Table.Cell>
                    <Table.Cell className="text-right font-mono text-sm">
                      {fmtQty(r.inv_usa)}
                    </Table.Cell>
                    <Table.Cell className="text-right font-mono text-sm text-ui-fg-subtle">
                      {fmtQty(r.alt_inv_usa)}
                    </Table.Cell>
                    <Table.Cell className="text-right font-mono text-sm text-ui-fg-subtle">
                      {fmtQty(r.inv_china)}
                    </Table.Cell>
                    <Table.Cell>
                      {r.abc_class ? (
                        <Badge
                          color={classBadgeColor(r.abc_class)}
                          size="2xsmall"
                        >
                          {r.abc_class}
                          {r.xyz_class ?? ""}
                        </Badge>
                      ) : (
                        <span className="text-ui-fg-subtle text-xs">—</span>
                      )}
                    </Table.Cell>
                    <Table.Cell className="text-right">
                      <div className="flex items-center justify-end gap-1">
                        <Button
                          variant="transparent"
                          size="small"
                          title="Add alternative"
                          onClick={(e) => {
                            e.stopPropagation();
                            setAddAltFor(r);
                          }}
                        >
                          <Plus />
                        </Button>
                        <Button
                          variant="transparent"
                          size="small"
                          onClick={(e) => {
                            e.stopPropagation();
                            navigate(
                              `/purchasing-alternatives/${r.primary_variant_id}`
                            );
                          }}
                        >
                          <ArrowsPointingOut />
                        </Button>
                      </div>
                    </Table.Cell>
                  </Table.Row>
                ))}
              </Table.Body>
            </Table>
          </div>
        )}
      </Container>

      {showAddPrimary && (
        <AddPrimaryModal
          onAdded={() => { setShowAddPrimary(false); void fetchList(); }}
          onClose={() => setShowAddPrimary(false)}
        />
      )}

      {addAltFor && (
        <AddAltModal
          primary={addAltFor}
          onAdded={() => { void fetchList(); }}
          onClose={() => setAddAltFor(null)}
        />
      )}
    </div>
  );
};

export const config = defineRouteConfig({
  label: "Alternatives",
  icon: Plus,
});

export default PurchasingAlternativesPage;
