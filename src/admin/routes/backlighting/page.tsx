import { defineRouteConfig } from "@medusajs/admin-sdk";
import { LightBulb } from "@medusajs/icons";
import {
    Container,
    Heading,
    Button,
    Input,
    Text,
    toast,
    Badge,
} from "@medusajs/ui";
import { useState, useEffect, useCallback } from "react";

interface Variant {
    id: string;
    sku: string;
    variant_title?: string;
    variant_metadata?: { backlighting?: { category: string; addedAt: string; addedBy: string } } | null;
    product_id: string;
    product_title: string;
    thumbnail?: string | null;
}

const CATEGORIES = [
    { key: "led-modules", label: "LED Modules" },
    { key: "led-drivers", label: "LED Drivers" },
    { key: "controllers", label: "Controllers" },
    { key: "amplifiers", label: "Amplifiers" },
    { key: "remotes", label: "Remotes" },
    { key: "accessories", label: "Accessories" },
] as const;

type CategoryKey = (typeof CATEGORIES)[number]["key"];

const BacklightingAdminPage = () => {
    const [activeTab, setActiveTab] = useState<CategoryKey>("led-modules");
    const [tabProducts, setTabProducts] = useState<Variant[]>([]);
    const [searchQuery, setSearchQuery] = useState("");
    const [searchResults, setSearchResults] = useState<Variant[]>([]);
    const [loading, setLoading] = useState(false);
    const [busy, setBusy] = useState(false);

    const fetchTabProducts = useCallback(async () => {
        setLoading(true);
        try {
            const r = await fetch(`/admin/backlighting?category=${activeTab}`, { credentials: "include" });
            const data = await r.json();
            setTabProducts(data.variants || []);
        } catch {
            toast.error("Failed to load Backlighting products");
        } finally {
            setLoading(false);
        }
    }, [activeTab]);

    useEffect(() => {
        fetchTabProducts();
    }, [fetchTabProducts]);

    const search = useCallback(async (q: string) => {
        if (!q.trim()) {
            setSearchResults([]);
            return;
        }
        try {
            const r = await fetch(`/admin/backlighting/search?q=${encodeURIComponent(q)}`, { credentials: "include" });
            const data = await r.json();
            setSearchResults(data.variants || []);
        } catch {
            // ignore
        }
    }, []);

    useEffect(() => {
        const t = setTimeout(() => search(searchQuery), 250);
        return () => clearTimeout(t);
    }, [searchQuery, search]);

    const addVariant = async (variant: Variant) => {
        setBusy(true);
        try {
            const r = await fetch(`/admin/backlighting/${variant.id}`, {
                method: "POST",
                credentials: "include",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ category: activeTab }),
            });
            if (!r.ok) throw new Error(await r.text());
            toast.success(`Added ${variant.product_title} (${variant.sku})`);
            setSearchQuery("");
            setSearchResults([]);
            fetchTabProducts();
        } catch {
            toast.error("Failed to add variant");
        } finally {
            setBusy(false);
        }
    };

    const removeVariant = async (variant: Variant) => {
        if (!window.confirm(`Remove ${variant.product_title} (${variant.sku}) from Backlighting?`)) return;
        setBusy(true);
        try {
            const r = await fetch(`/admin/backlighting/${variant.id}`, {
                method: "DELETE",
                credentials: "include",
            });
            if (!r.ok) throw new Error(await r.text());
            toast.success("Removed");
            fetchTabProducts();
        } catch {
            toast.error("Failed to remove variant");
        } finally {
            setBusy(false);
        }
    };

    return (
        <Container className="p-6">
            <Heading level="h1" className="mb-1">Backlighting Catalog</Heading>
            <Text className="text-ui-fg-muted mb-6">
                Tag Medusa product variants for use by the Backlighting calculator. The Backlighting webapp pulls
                tagged variants from this list and merges them with its local geometry data (cuts, plugs, LEDs).
            </Text>

            {/* Tabs */}
            <div className="flex gap-2 mb-6 border-b border-ui-border-base">
                {CATEGORIES.map((c) => (
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

            {/* Search bar */}
            <div className="mb-4">
                <Input
                    placeholder={`Search any Medusa product/SKU to add to ${CATEGORIES.find((c) => c.key === activeTab)?.label}...`}
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                />
                {searchResults.length > 0 && (
                    <div className="mt-2 border border-ui-border-base rounded bg-ui-bg-base shadow-sm max-h-72 overflow-y-auto">
                        {searchResults.map((v) => {
                            const tagged = v.variant_metadata?.backlighting?.category;
                            return (
                                <div
                                    key={v.id}
                                    className="p-3 flex items-center justify-between border-b border-ui-border-base last:border-b-0 hover:bg-ui-bg-base-hover"
                                >
                                    <div className="flex flex-col gap-0.5">
                                        <Text size="small" weight="plus">{v.product_title}</Text>
                                        <Text size="xsmall" className="text-ui-fg-muted font-mono">
                                            SKU: {v.sku || "—"}
                                            {v.variant_title && v.variant_title !== "Default" && ` · ${v.variant_title}`}
                                        </Text>
                                        {tagged && (
                                            <Badge size="2xsmall" color="orange" className="mt-1 self-start">
                                                Already tagged: {tagged}
                                            </Badge>
                                        )}
                                    </div>
                                    <Button
                                        size="small"
                                        variant="secondary"
                                        disabled={busy}
                                        onClick={() => addVariant(v)}
                                    >
                                        + Add to {CATEGORIES.find((c) => c.key === activeTab)?.label}
                                    </Button>
                                </div>
                            );
                        })}
                    </div>
                )}
            </div>

            {/* Tab content */}
            <div>
                <div className="flex items-center justify-between mb-3">
                    <Heading level="h2">
                        {CATEGORIES.find((c) => c.key === activeTab)?.label}{" "}
                        <span className="text-ui-fg-muted text-base font-normal">({tabProducts.length})</span>
                    </Heading>
                </div>

                {loading ? (
                    <Text className="text-ui-fg-muted">Loading…</Text>
                ) : tabProducts.length === 0 ? (
                    <div className="border border-dashed border-ui-border-base rounded p-8 text-center">
                        <Text className="text-ui-fg-muted">
                            No {CATEGORIES.find((c) => c.key === activeTab)?.label.toLowerCase()} tagged yet. Use the search above to add some.
                        </Text>
                    </div>
                ) : (
                    <div className="border border-ui-border-base rounded bg-ui-bg-base divide-y divide-ui-border-base">
                        {tabProducts.map((v) => (
                            <div key={v.id} className="p-3 flex items-center justify-between">
                                <div className="flex flex-col gap-0.5">
                                    <Text size="small" weight="plus">{v.product_title}</Text>
                                    <Text size="xsmall" className="text-ui-fg-muted font-mono">
                                        SKU: {v.sku || "—"}
                                        {v.variant_title && v.variant_title !== "Default" && ` · ${v.variant_title}`}
                                    </Text>
                                </div>
                                <Button
                                    size="small"
                                    variant="danger"
                                    disabled={busy}
                                    onClick={() => removeVariant(v)}
                                >
                                    Remove
                                </Button>
                            </div>
                        ))}
                    </div>
                )}
            </div>
        </Container>
    );
};

export const config = defineRouteConfig({
    label: "Backlighting",
    icon: LightBulb,
});

export default BacklightingAdminPage;
