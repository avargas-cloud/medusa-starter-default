import { defineRouteConfig } from "@medusajs/admin-sdk";
import { Sparkles } from "@medusajs/icons";
import { Badge, Button, Container, Heading, Input, Text, toast } from "@medusajs/ui";
import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";

/**
 * Página de SELECCIÓN pura (split 2026-08-20): acá sólo se taggea qué
 * productos participan y en qué sistema(s). Toda la configuración técnica
 * (specs) vive en el Admin del app Linear Lighting, no en Medusa.
 * Claves estables espejo de shared/catalog-types.ts — el label es sólo UI.
 */
const LL_CATEGORIES = [
    { key: "led_strip", label: "LED Strips" },
    { key: "led_neon", label: "LED Neons" },
    { key: "led_driver", label: "LED Drivers" },
    { key: "sensor", label: "Sensors" },
    { key: "controller", label: "Controllers" },
    { key: "amplifier", label: "Amplifiers" },
    { key: "remote", label: "Remotes" },
    { key: "led_strip_accessory", label: "LED Strip Accessories" },
    { key: "led_driver_accessory", label: "LED Driver Accessories" },
    { key: "led_neon_accessory", label: "LED Neon Accessories" },
] as const;

type LlCategoryKey = (typeof LL_CATEGORIES)[number]["key"];
type LlSystem = "easyled" | "essential";

interface LlVariantRow {
    id: string;
    sku: string | null;
    title: string | null;
}

interface LlProductRow {
    id: string;
    title: string;
    thumbnail: string | null;
    linear_lighting: { category?: string; systems?: unknown } | null;
    variants: LlVariantRow[];
}

const systemsOf = (p: LlProductRow): LlSystem[] => {
    const s = p.linear_lighting?.systems;
    return Array.isArray(s) ? (s as LlSystem[]) : [];
};

const SYSTEM_TOGGLE_ACTIVE_CLASS =
    "!bg-ui-bg-interactive !text-ui-fg-on-color !border-ui-bg-interactive !shadow-none";

const LinearLightingAdminPage = () => {
    const [activeTab, setActiveTab] = useState<LlCategoryKey>("led_strip");
    const [products, setProducts] = useState<LlProductRow[]>([]);
    const [searchQuery, setSearchQuery] = useState("");
    const [searchResults, setSearchResults] = useState<LlProductRow[]>([]);
    const [loading, setLoading] = useState(false);
    const [saving, setSaving] = useState<string | null>(null);

    const fetchProducts = useCallback(async () => {
        setLoading(true);
        try {
            const params = new URLSearchParams({ category: activeTab });
            const r = await fetch(`/admin/linear-lighting?${params}`, { credentials: "include" });
            if (!r.ok) throw new Error(`HTTP ${r.status}`);
            const data = (await r.json()) as { products: LlProductRow[] };
            setProducts(data.products || []);
        } catch {
            toast.error("Failed to load Linear Lighting products");
        } finally {
            setLoading(false);
        }
    }, [activeTab]);

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

    const saveTag = async (productId: string, category: string, systems: LlSystem[]) => {
        setSaving(productId);
        try {
            const r = await fetch(`/admin/linear-lighting/${productId}`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                credentials: "include",
                body: JSON.stringify({ category, systems }),
            });
            if (!r.ok) throw new Error(await r.text());
            fetchProducts();
        } catch {
            toast.error("Failed to save tag");
        } finally {
            setSaving(null);
        }
    };

    const addProduct = async (p: LlProductRow) => {
        setSearchQuery("");
        setSearchResults([]);
        await saveTag(p.id, activeTab, ["easyled", "essential"]);
        toast.success(`Added to ${categoryLabel}`);
    };

    const toggleSystem = async (p: LlProductRow, system: LlSystem) => {
        const current = systemsOf(p);
        const next = current.includes(system)
            ? current.filter((s) => s !== system)
            : [...current, system];
        await saveTag(p.id, (p.linear_lighting?.category as string) || activeTab, next);
    };

    const removeProduct = async (product: LlProductRow) => {
        if (!window.confirm(`Remove “${product.title}” from the Linear Lighting catalog?`)) return;
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

    const categoryLabel = LL_CATEGORIES.find((c) => c.key === activeTab)?.label ?? activeTab;

    return (
        <Container className="p-6">
            <Heading level="h1" className="mb-1">Linear Lighting Catalog</Heading>
            <Text className="text-ui-fg-muted mb-6">
                Tag Medusa products for the Linear Lighting Designer and choose which system(s) each one
                belongs to (a product can be in both). Technical specs (roll length, watts per roll,
                connections…) are configured in the Linear Lighting app admin — not here.
            </Text>

            <div className="flex gap-1 mb-4 border-b border-ui-border-base flex-wrap">
                {LL_CATEGORIES.map((c) => (
                    <button
                        key={c.key}
                        onClick={() => setActiveTab(c.key)}
                        className={`px-3 py-2 text-sm font-medium border-b-2 transition-colors whitespace-nowrap ${
                            activeTab === c.key
                                ? "border-ui-fg-interactive text-ui-fg-interactive"
                                : "border-transparent text-ui-fg-muted hover:text-ui-fg-base"
                        }`}
                    >
                        {c.label}
                    </button>
                ))}
            </div>

            <div className="mb-4">
                <Input
                    placeholder={`Search any product/SKU to add to ${categoryLabel}…`}
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
                                                Already tagged: {taggedCategory}
                                            </Badge>
                                        )}
                                    </div>
                                    <Button
                                        size="small"
                                        variant="secondary"
                                        disabled={saving === p.id}
                                        onClick={() => addProduct(p)}
                                    >
                                        {taggedCategory ? `Move to ${categoryLabel}` : `+ Add to ${categoryLabel}`}
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
                        No {categoryLabel.toLowerCase()} tagged yet. Use the search above to add products.
                    </Text>
                </div>
            ) : (
                <div className="border border-ui-border-base rounded bg-ui-bg-base divide-y divide-ui-border-base">
                    {products.map((p) => {
                        const systems = systemsOf(p);
                        return (
                            <div key={p.id} className="p-3 flex items-center justify-between gap-3">
                                <div className="flex flex-col gap-0.5 min-w-0">
                                    <Link
                                        to={`/products/${p.id}`}
                                        className="w-fit hover:underline"
                                        title="Open product page"
                                    >
                                        {/* Un producto sin título dejaría el link sin texto clickeable. */}
                                        <Text size="small" weight="plus">
                                            {p.title.trim() ||
                                                p.variants.find((v) => v.sku)?.sku ||
                                                "(untitled product)"}
                                        </Text>
                                    </Link>
                                    <Text size="xsmall" className="text-ui-fg-muted font-mono truncate">
                                        {p.variants.map((v) => v.sku).filter(Boolean).join(" · ") || "no SKU"}
                                    </Text>
                                    {systems.length === 0 && (
                                        <Badge size="2xsmall" color="grey" className="mt-1 self-start">
                                            no system — inactive
                                        </Badge>
                                    )}
                                </div>
                                <div className="flex gap-2 shrink-0 items-center">
                                    <Button
                                        size="small"
                                        variant="secondary"
                                        className={systems.includes("easyled") ? SYSTEM_TOGGLE_ACTIVE_CLASS : undefined}
                                        disabled={saving === p.id}
                                        onClick={() => toggleSystem(p, "easyled")}
                                    >
                                        EASYLED
                                    </Button>
                                    <Button
                                        size="small"
                                        variant="secondary"
                                        className={systems.includes("essential") ? SYSTEM_TOGGLE_ACTIVE_CLASS : undefined}
                                        disabled={saving === p.id}
                                        onClick={() => toggleSystem(p, "essential")}
                                    >
                                        Essential
                                    </Button>
                                    <Button size="small" variant="danger" onClick={() => removeProduct(p)}>
                                        Remove
                                    </Button>
                                </div>
                            </div>
                        );
                    })}
                </div>
            )}
        </Container>
    );
};

export const config = defineRouteConfig({
    label: "Linear Lighting",
    icon: Sparkles,
});

export default LinearLightingAdminPage;
