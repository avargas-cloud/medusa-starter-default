import { ArrowLeft, Trash, Plus, MagnifyingGlass } from "@medusajs/icons";
import {
  Badge,
  Button,
  Container,
  Heading,
  Table,
  Text,
  toast,
} from "@medusajs/ui";
import { useEffect, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";

// ── Types ─────────────────────────────────────────────────────────────────────

type PrimaryVariant = {
  id: string;
  sku: string;
  product_title: string;
  product_id: string;
  inv_usa: number;
  inv_china: number;
  abc_class: string | null;
  xyz_class: string | null;
};

type AltRow = {
  link_id: string;
  priority: number;
  variant_id: string;
  sku: string;
  product_title: string;
  inv_usa: number;
  inv_china: number;
  abc_class: string | null;
  xyz_class: string | null;
};

type ReverseRow = {
  link_id: string;
  primary_variant_id: string;
  primary_sku: string;
  primary_title: string;
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
): "green" | "blue" | "orange" | "grey" => {
  if (!cls) return "grey";
  const c = cls.toUpperCase();
  if (c.startsWith("A")) return "green";
  if (c.startsWith("B")) return "blue";
  if (c.startsWith("C")) return "orange";
  return "grey";
};

const fmtQty = (n: number) => n.toLocaleString();

// ── Add Alternative Modal ──────────────────────────────────────────────────────

type AddModalProps = {
  primaryVariantId: string;
  excludeIds: string[];
  onAdded: () => void;
  onClose: () => void;
};

const AddAlternativeModal = ({
  primaryVariantId,
  excludeIds,
  onAdded,
  onClose,
}: AddModalProps) => {
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
    if (query.length < 2) {
      setResults([]);
      return;
    }
    debounceRef.current = setTimeout(async () => {
      setSearching(true);
      try {
        const exclude = excludeIds.join(",");
        const res = await fetch(
          `/admin/purchasing/variants/search?q=${encodeURIComponent(query)}&exclude=${encodeURIComponent(exclude)}`,
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
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [query, excludeIds.join(",")]);

  const handleAdd = async (altVariantId: string) => {
    setAdding(altVariantId);
    try {
      const res = await fetch("/admin/purchasing/alternatives", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          primary_variant_id: primaryVariantId,
          alt_variant_id: altVariantId,
        }),
      });
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        throw new Error(
          (d as { error?: string }).error ?? `HTTP ${res.status}`
        );
      }
      toast.success("Alternative linked");
      onAdded();
    } catch (e) {
      toast.error("Failed to link alternative", {
        description: (e as Error).message,
      });
    } finally {
      setAdding(null);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
      onClick={(e) => e.target === e.currentTarget && onClose()}
    >
      <div className="bg-ui-bg-base rounded-xl shadow-2xl w-full max-w-lg mx-4 overflow-hidden">
        <div className="flex items-center justify-between px-5 py-4 border-b border-ui-border-base">
          <Heading level="h2">Add Alternative SKU</Heading>
          <Button variant="transparent" size="small" onClick={onClose}>
            ✕
          </Button>
        </div>

        <div className="px-5 py-3 border-b border-ui-border-base">
          <div className="relative">
            <MagnifyingGlass className="absolute left-3 top-1/2 -translate-y-1/2 text-ui-fg-subtle w-4 h-4" />
            <input
              ref={inputRef}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search by SKU or product title…"
              className="w-full pl-9 pr-4 py-2 text-sm bg-ui-bg-subtle border border-ui-border-base rounded-lg focus:outline-none focus:ring-2 focus:ring-ui-border-interactive text-ui-fg-base placeholder:text-ui-fg-muted"
            />
          </div>
          {searching && (
            <Text className="text-ui-fg-subtle text-xs mt-1">Searching…</Text>
          )}
        </div>

        <div className="max-h-72 overflow-y-auto">
          {results.length === 0 && query.length >= 2 && !searching && (
            <Text className="text-ui-fg-subtle text-sm px-5 py-4">
              No results found.
            </Text>
          )}
          {query.length < 2 && (
            <Text className="text-ui-fg-subtle text-sm px-5 py-4">
              Type at least 2 characters to search…
            </Text>
          )}
          {results.map((r) => (
            <div
              key={r.id}
              className="flex items-center justify-between px-5 py-3 border-b border-ui-border-base last:border-0 hover:bg-ui-bg-base-hover"
            >
              <div className="flex flex-col gap-0.5 min-w-0">
                <span className="font-mono text-sm font-semibold truncate">
                  {r.sku}
                </span>
                <span className="text-ui-fg-subtle text-xs truncate">
                  {r.product_title}
                </span>
              </div>
              <div className="flex items-center gap-3 ml-3 shrink-0">
                <span className="text-ui-fg-subtle text-xs font-mono">
                  {fmtQty(r.inv_usa)} in stock
                </span>
                <Button
                  size="small"
                  variant="secondary"
                  isLoading={adding === r.id}
                  disabled={adding !== null}
                  onClick={() => handleAdd(r.id)}
                >
                  <Plus />
                  Add
                </Button>
              </div>
            </div>
          ))}
        </div>

        <div className="px-5 py-3 border-t border-ui-border-base flex justify-end">
          <Button variant="secondary" size="small" onClick={onClose}>
            Close
          </Button>
        </div>
      </div>
    </div>
  );
};

// ── Main Page ─────────────────────────────────────────────────────────────────

const PurchasingAlternativeDetailPage = () => {
  const { variantId } = useParams<{ variantId: string }>();
  const navigate = useNavigate();

  const [primary, setPrimary] = useState<PrimaryVariant | null>(null);
  const [alts, setAlts] = useState<AltRow[]>([]);
  const [reverseLinks, setReverseLinks] = useState<ReverseRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [showModal, setShowModal] = useState(false);
  const [removing, setRemoving] = useState<string | null>(null);

  const fetchDetail = async () => {
    if (!variantId) return;
    setLoading(true);
    try {
      const res = await fetch(`/admin/purchasing/alternatives/${variantId}`, {
        credentials: "include",
      });
      if (res.status === 404) {
        toast.error("Variant not found");
        navigate("/purchasing-alternatives");
        return;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setPrimary(data.primary ?? null);
      setAlts(data.alternatives ?? []);
      setReverseLinks(data.reverse_links ?? []);
    } catch (e) {
      toast.error("Failed to load alternatives", {
        description: (e as Error).message,
      });
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchDetail();
  }, [variantId]);

  const handleRemove = async (linkId: string) => {
    setRemoving(linkId);
    try {
      const res = await fetch(`/admin/purchasing/alternatives/${linkId}`, {
        method: "DELETE",
        credentials: "include",
      });
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        throw new Error(
          (d as { error?: string }).error ?? `HTTP ${res.status}`
        );
      }
      toast.success("Alternative removed");
      await fetchDetail();
    } catch (e) {
      toast.error("Failed to remove alternative", {
        description: (e as Error).message,
      });
    } finally {
      setRemoving(null);
    }
  };

  const excludeIds = [variantId ?? "", ...alts.map((a) => a.variant_id)].filter(
    Boolean
  );

  if (loading) {
    return (
      <div className="p-6">
        <Text className="text-ui-fg-subtle">Loading…</Text>
      </div>
    );
  }

  if (!primary) return null;

  const abcxyz =
    primary.abc_class && primary.xyz_class
      ? `${primary.abc_class}${primary.xyz_class}`
      : (primary.abc_class ?? null);

  return (
    <>
      {showModal && (
        <AddAlternativeModal
          primaryVariantId={primary.id}
          excludeIds={excludeIds}
          onAdded={async () => {
            await fetchDetail();
          }}
          onClose={() => setShowModal(false)}
        />
      )}

      <div className="flex flex-col gap-5 p-6">
        {/* Header */}
        <div className="flex items-center gap-3">
          <Button
            variant="transparent"
            size="small"
            onClick={() => navigate("/purchasing-alternatives")}
          >
            <ArrowLeft />
          </Button>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <Heading level="h1" className="font-mono">
                {primary.sku}
              </Heading>
              {abcxyz && (
                <Badge color={classBadgeColor(primary.abc_class)} size="small">
                  {abcxyz}
                </Badge>
              )}
            </div>
            <Text className="text-ui-fg-subtle truncate">
              {primary.product_title}
            </Text>
          </div>
        </div>

        {/* Primary inventory summary */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          <InventoryCard label="Inv USA" value={primary.inv_usa} />
          <InventoryCard label="China WH" value={primary.inv_china} />
          <InventoryCard
            label="Alt Inv (combined)"
            value={alts.reduce((s, a) => s + a.inv_usa, 0)}
            muted
          />
          <InventoryCard
            label="Alt China (combined)"
            value={alts.reduce((s, a) => s + a.inv_china, 0)}
            muted
          />
        </div>

        {/* Alternatives list */}
        <Container className="p-0">
          <div className="flex items-center justify-between px-6 py-3 border-b border-ui-border-base">
            <Heading level="h2" className="text-base">
              Alternative SKUs{" "}
              {alts.length > 0 && (
                <span className="text-ui-fg-subtle font-normal text-sm">
                  ({alts.length})
                </span>
              )}
            </Heading>
            <Button
              size="small"
              variant="secondary"
              onClick={() => setShowModal(true)}
            >
              <Plus />
              Add Alternative
            </Button>
          </div>

          {alts.length === 0 ? (
            <Text className="text-ui-fg-subtle px-6 py-5 text-sm">
              No alternatives linked yet. Click "Add Alternative" to link one.
            </Text>
          ) : (
            <Table>
              <Table.Header>
                <Table.Row>
                  <Table.HeaderCell>Priority</Table.HeaderCell>
                  <Table.HeaderCell>SKU</Table.HeaderCell>
                  <Table.HeaderCell>Product</Table.HeaderCell>
                  <Table.HeaderCell className="text-right">
                    Inv USA
                  </Table.HeaderCell>
                  <Table.HeaderCell className="text-right">
                    China WH
                  </Table.HeaderCell>
                  <Table.HeaderCell>Class</Table.HeaderCell>
                  <Table.HeaderCell />
                </Table.Row>
              </Table.Header>
              <Table.Body>
                {alts.map((a) => (
                  <Table.Row key={a.link_id}>
                    <Table.Cell>
                      <span className="font-mono text-sm text-ui-fg-subtle">
                        #{a.priority}
                      </span>
                    </Table.Cell>
                    <Table.Cell>
                      <span className="font-mono text-sm font-semibold">
                        {a.sku}
                      </span>
                    </Table.Cell>
                    <Table.Cell className="text-ui-fg-subtle text-sm max-w-xs truncate">
                      {a.product_title}
                    </Table.Cell>
                    <Table.Cell className="text-right font-mono text-sm">
                      {fmtQty(a.inv_usa)}
                    </Table.Cell>
                    <Table.Cell className="text-right font-mono text-sm text-ui-fg-subtle">
                      {fmtQty(a.inv_china)}
                    </Table.Cell>
                    <Table.Cell>
                      {a.abc_class ? (
                        <Badge
                          color={classBadgeColor(a.abc_class)}
                          size="2xsmall"
                        >
                          {a.abc_class}
                          {a.xyz_class ?? ""}
                        </Badge>
                      ) : (
                        <span className="text-ui-fg-subtle text-xs">—</span>
                      )}
                    </Table.Cell>
                    <Table.Cell className="text-right">
                      <Button
                        variant="transparent"
                        size="small"
                        isLoading={removing === a.link_id}
                        disabled={removing !== null}
                        onClick={() => handleRemove(a.link_id)}
                        title="Remove this alternative"
                      >
                        <Trash className="text-ui-fg-subtle hover:text-ui-fg-error" />
                      </Button>
                    </Table.Cell>
                  </Table.Row>
                ))}
              </Table.Body>
            </Table>
          )}
        </Container>

        {/* Reverse links */}
        {reverseLinks.length > 0 && (
          <Container className="p-0">
            <div className="px-6 py-3 border-b border-ui-border-base">
              <Heading level="h2" className="text-base">
                This SKU is alternative of
              </Heading>
              <Text className="text-ui-fg-subtle text-xs mt-0.5">
                These primary products list{" "}
                <span className="font-mono">{primary.sku}</span> as an
                alternative.
              </Text>
            </div>
            <Table>
              <Table.Header>
                <Table.Row>
                  <Table.HeaderCell>Primary SKU</Table.HeaderCell>
                  <Table.HeaderCell>Product</Table.HeaderCell>
                  <Table.HeaderCell />
                </Table.Row>
              </Table.Header>
              <Table.Body>
                {reverseLinks.map((r) => (
                  <Table.Row key={r.link_id}>
                    <Table.Cell>
                      <span className="font-mono text-sm font-semibold">
                        {r.primary_sku}
                      </span>
                    </Table.Cell>
                    <Table.Cell className="text-ui-fg-subtle text-sm">
                      {r.primary_title}
                    </Table.Cell>
                    <Table.Cell className="text-right">
                      <Button
                        variant="transparent"
                        size="small"
                        onClick={() =>
                          navigate(
                            `/purchasing-alternatives/${r.primary_variant_id}`
                          )
                        }
                      >
                        <span className="text-xs">View →</span>
                      </Button>
                    </Table.Cell>
                  </Table.Row>
                ))}
              </Table.Body>
            </Table>
          </Container>
        )}
      </div>
    </>
  );
};

// ── Small inventory stat card ─────────────────────────────────────────────────

const InventoryCard = ({
  label,
  value,
  muted = false,
}: {
  label: string;
  value: number;
  muted?: boolean;
}) => (
  <Container className="p-4 flex flex-col gap-1">
    <Text className="text-ui-fg-subtle text-xs uppercase tracking-wide">
      {label}
    </Text>
    <span
      className={`text-2xl font-mono font-semibold ${muted ? "text-ui-fg-subtle" : "text-ui-fg-base"}`}
    >
      {value.toLocaleString()}
    </span>
  </Container>
);

export default PurchasingAlternativeDetailPage;
