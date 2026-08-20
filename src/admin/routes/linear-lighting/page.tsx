import { defineRouteConfig } from "@medusajs/admin-sdk";
import { Sparkles } from "@medusajs/icons";
import { Badge, Button, Container, Heading, Input, Text, toast } from "@medusajs/ui";
import { useCallback, useEffect, useState } from "react";
import { LL_CATEGORIES, type LlCategoryKey } from "./fields";
import { ProductFormDrawer, type LlProductRow } from "./product-form";

type SystemFilter = "all" | "easyled" | "essential";

const SYSTEM_FILTERS: { key: SystemFilter; label: string }[] = [
    { key: "all", label: "All systems" },
    { key: "easyled", label: "EASYLED" },
    { key: "essential", label: "Essential" },
];

const LinearLightingAdminPage = () => {
    const [activeTab, setActiveTab] = useState<LlCategoryKey>("strip");
    const [systemFilter, setSystemFilter] = useState<SystemFilter>("all");
    const [products, setProducts] = useState<LlProductRow[]>([]);
    const [searchQuery, setSearchQuery] = useState("");
    const [searchResults, setSearchResults] = useState<LlProductRow[]>([]);
    const [loading, setLoading] = useState(false);
    const [editing, setEditing] = useState<LlProductRow | null>(null);

    const fetchProducts = useCallback(async () => {
        setLoading(true);
        try {
            const params = new URLSearchParams({ category: activeTab });
            if (systemFilter !== "all") params.set("system", systemFilter);
            const r = await fetch(`/admin/linear-lighting?${params}`, { credentials: "include" });
            if (!r.ok) throw new Error(`HTTP ${r.status}`);
            const data = (await r.json()) as { products: LlProductRow[] };
            setProducts(data.products || []);
        } catch {
            toast.error("Failed to load Linear Lighting products");
        } finally {
            setLoading(false);
        }
    }, [activeTab, systemFilter]);

    useEffect(() => {
        fetchProducts();
    }, [fetchProducts]);

    const search = useCallback(async (q: string) => {
        if (!q.trim()) {
            setSearchResults([]);
            return;
        }
        try {
            const r = await fetch(`/admin/linear-lighting/search?q=${encodeURIComponent(q)}`, {
                credentials: "include",
            });
            if (!r.ok) return;
            const data = (await r.json()) as { products: LlProductRow[] };
            setSearchResults(data.products || []);
        } catch {
            /* búsqueda silenciosa */
        }
    }, []);

    useEffect(() => {
        const t = setTimeout(() => search(searchQuery), 250);
        return () => clearTimeout(t);
    }, [searchQuery, search]);

    const removeProduct = async (product: LlProductRow) => {
        if (!window.confirm(`Remove “${product.title}” from the Linear Lighting calculator?`)) return;
        try {
            const r = await fetch(`/admin/linear-lighting/${product.id}`, {
                method: "DELETE",
                credentials: "include",
            });
            if (!r.ok) throw new Error(await r.text());
            toast.success("Removed");
            fetchProducts();
        } catch {
            toast.error("Failed to remove product");
        }
    };

    const systemsOf = (p: LlProductRow): string[] => {
        const s = p.linear_lighting?.systems;
        return Array.isArray(s) ? (s as string[]) : [];
    };

    const categoryLabel = LL_CATEGORIES.find((c) => c.key === activeTab)?.label ?? activeTab;

    return (
        <Container className="p-6">
            <Heading level="h1" className="mb-1">Linear Lighting Catalog</Heading>
            <Text className="text-ui-fg-muted mb-6">
                Configure which products participate in the Linear Lighting Designer (EASYLED / Essential),
                their calculator metadata and customer-facing friendly names. The designer syncs this data
                into an immutable catalog snapshot.
            </Text>

            <div className="flex gap-2 mb-4 border-b border-ui-border-base">
                {LL_CATEGORIES.map((c) => (
                    <button
                        key={c.key}
                        onClick={() => setActiveTab(c.key)}
                        className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
                            activeTab === c.key
                                ? "border-ui-fg-interactive text-ui-fg-interactive"
                                : "border-transparent text-ui-fg-muted hover:text-ui-fg-base"
                        }`}
                    >
                        {c.label}
                    </button>
                ))}
            </div>

            <div className="flex gap-2 mb-4">
                {SYSTEM_FILTERS.map((f) => (
                    <Button
                        key={f.key}
                        size="small"
                        variant={systemFilter === f.key ? "primary" : "secondary"}
                        onClick={() => setSystemFilter(f.key)}
                    >
                        {f.label}
                    </Button>
                ))}
            </div>

            <div className="mb-4">
                <Input
                    placeholder={`Search any product/SKU to add as ${categoryLabel}…`}
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                />
                {searchResults.length > 0 && (
                    <div className="mt-2 border border-ui-border-base rounded bg-ui-bg-base shadow-sm max-h-72 overflow-y-auto">
                        {searchResults.map((p) => {
                            const taggedCategory = p.linear_lighting?.category as string | undefined;
                            return (
                                <div
                                    key={p.id}
                                    className="p-3 flex items-center justify-between border-b border-ui-border-base last:border-b-0 hover:bg-ui-bg-base-hover"
                                >
                                    <div className="flex flex-col gap-0.5">
                                        <Text size="small" weight="plus">{p.title}</Text>
                                        <Text size="xsmall" className="text-ui-fg-muted font-mono">
                                            {p.variants.map((v) => v.sku).filter(Boolean).join(" · ") || "no SKU"}
                                        </Text>
                                        {taggedCategory && (
                                            <Badge size="2xsmall" color="orange" className="mt-1 self-start">
                                                Already configured: {taggedCategory}
                                            </Badge>
                                        )}
                                    </div>
                                    <Button
                                        size="small"
                                        variant="secondary"
                                        onClick={() => {
                                            setSearchQuery("");
                                            setSearchResults([]);
                                            setEditing(p);
                                        }}
                                    >
                                        {taggedCategory ? "Edit config" : `+ Add as ${categoryLabel}`}
                                    </Button>
                                </div>
                            );
                        })}
                    </div>
                )}
            </div>

            <div className="flex items-center justify-between mb-3">
                <Heading level="h2">
                    {categoryLabel}{" "}
                    <span className="text-ui-fg-muted text-base font-normal">({products.length})</span>
                </Heading>
            </div>

            {loading ? (
                <Text className="text-ui-fg-muted">Loading…</Text>
            ) : products.length === 0 ? (
                <div className="border border-dashed border-ui-border-base rounded p-8 text-center">
                    <Text className="text-ui-fg-muted">
                        No {categoryLabel.toLowerCase()} configured yet. Use the search above to add products.
                    </Text>
                </div>
            ) : (
                <div className="border border-ui-border-base rounded bg-ui-bg-base divide-y divide-ui-border-base">
                    {products.map((p) => (
                        <div key={p.id} className="p-3 flex items-center justify-between gap-3">
                            <div className="flex flex-col gap-0.5 min-w-0">
                                <div className="flex items-center gap-2">
                                    <Text size="small" weight="plus">{p.title}</Text>
                                    {typeof p.linear_lighting?.friendly_name === "string" && (
                                        <Badge size="2xsmall" color="blue">
                                            “{p.linear_lighting.friendly_name}”
                                        </Badge>
                                    )}
                                </div>
                                <Text size="xsmall" className="text-ui-fg-muted font-mono truncate">
                                    {p.variants.map((v) => v.sku).filter(Boolean).join(" · ") || "no SKU"}
                                </Text>
                                <div className="flex gap-1 mt-1">
                                    {systemsOf(p).length === 0 && (
                                        <Badge size="2xsmall" color="grey">no system — inactive</Badge>
                                    )}
                                    {systemsOf(p).includes("easyled") && (
                                        <Badge size="2xsmall" color="green">EASYLED</Badge>
                                    )}
                                    {systemsOf(p).includes("essential") && (
                                        <Badge size="2xsmall" color="purple">Essential</Badge>
                                    )}
                                </div>
                            </div>
                            <div className="flex gap-2 shrink-0">
                                <Button size="small" variant="secondary" onClick={() => setEditing(p)}>
                                    Edit
                                </Button>
                                <Button size="small" variant="danger" onClick={() => removeProduct(p)}>
                                    Remove
                                </Button>
                            </div>
                        </div>
                    ))}
                </div>
            )}

            <ProductFormDrawer
                product={editing}
                category={(editing?.linear_lighting?.category as LlCategoryKey) || activeTab}
                open={editing !== null}
                onClose={() => setEditing(null)}
                onSaved={() => {
                    setEditing(null);
                    toast.success("Saved");
                    fetchProducts();
                }}
            />
        </Container>
    );
};

export const config = defineRouteConfig({
    label: "Linear Lighting",
    icon: Sparkles,
});

export default LinearLightingAdminPage;
