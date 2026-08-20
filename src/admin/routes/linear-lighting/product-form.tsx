import { Button, Drawer, Input, Label, Select, Text, Checkbox } from "@medusajs/ui";
import { useEffect, useState } from "react";
import {
    fieldsFor,
    parseFormValues,
    toFormValues,
    type FieldDef,
    type LlCategoryKey,
} from "./fields";

export interface LlProductRow {
    id: string;
    title: string;
    thumbnail?: string | null;
    linear_lighting: Record<string, unknown> | null;
    variants: { id: string; sku: string | null; title: string | null }[];
}

interface ProductFormDrawerProps {
    product: LlProductRow | null;
    category: LlCategoryKey;
    open: boolean;
    onClose: () => void;
    onSaved: () => void;
}

const SYSTEM_OPTIONS = [
    { key: "easyled", label: "EASYLED" },
    { key: "essential", label: "Essential" },
] as const;

export function ProductFormDrawer({ product, category, open, onClose, onSaved }: ProductFormDrawerProps) {
    const [values, setValues] = useState<Record<string, string>>({});
    const [systems, setSystems] = useState<string[]>([]);
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        if (!product) return;
        setValues(toFormValues(product.linear_lighting));
        const existing = product.linear_lighting?.systems;
        setSystems(Array.isArray(existing) ? (existing as string[]) : []);
        setError(null);
    }, [product]);

    if (!product) return null;

    const fields = fieldsFor(category);
    const missingRequired = fields.filter((f) => f.required && !values[f.key]?.trim());

    const save = async () => {
        setSaving(true);
        setError(null);
        try {
            const body = parseFormValues(category, systems, values);
            const r = await fetch(`/admin/linear-lighting/${product.id}`, {
                method: "POST",
                credentials: "include",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(body),
            });
            if (!r.ok) {
                const data = (await r.json().catch(() => null)) as { error?: string } | null;
                throw new Error(data?.error || `HTTP ${r.status}`);
            }
            onSaved();
        } catch (e) {
            setError(e instanceof Error ? e.message : "Save failed");
        } finally {
            setSaving(false);
        }
    };

    const renderField = (field: FieldDef) => {
        const value = values[field.key] ?? "";
        const set = (v: string) => setValues((prev) => ({ ...prev, [field.key]: v }));
        return (
            <div key={field.key} className="flex flex-col gap-1">
                <Label size="small" weight="plus">
                    {field.label}
                    {field.required ? " *" : ""}
                </Label>
                {field.type === "select" && field.options ? (
                    <Select value={value || undefined} onValueChange={set}>
                        <Select.Trigger>
                            <Select.Value placeholder="—" />
                        </Select.Trigger>
                        <Select.Content>
                            {field.options.map((o) => (
                                <Select.Item key={o.value} value={o.value}>
                                    {o.label}
                                </Select.Item>
                            ))}
                        </Select.Content>
                    </Select>
                ) : (
                    <Input
                        type={field.type === "number" ? "number" : "text"}
                        value={value}
                        onChange={(e) => set(e.target.value)}
                    />
                )}
                {field.help && (
                    <Text size="xsmall" className="text-ui-fg-muted">
                        {field.help}
                    </Text>
                )}
            </div>
        );
    };

    return (
        <Drawer open={open} onOpenChange={(o) => !o && onClose()}>
            <Drawer.Content>
                <Drawer.Header>
                    <Drawer.Title>{product.title}</Drawer.Title>
                    <Text size="small" className="text-ui-fg-muted font-mono">
                        {product.variants.map((v) => v.sku).filter(Boolean).join(" · ") || "no SKU"}
                    </Text>
                </Drawer.Header>
                <Drawer.Body className="flex flex-col gap-4 overflow-y-auto">
                    <div className="flex flex-col gap-1">
                        <Label size="small" weight="plus">Systems *</Label>
                        <div className="flex gap-4">
                            {SYSTEM_OPTIONS.map((s) => (
                                <label key={s.key} className="flex items-center gap-2 cursor-pointer">
                                    <Checkbox
                                        checked={systems.includes(s.key)}
                                        onCheckedChange={(checked) =>
                                            setSystems((prev) =>
                                                checked === true
                                                    ? [...prev, s.key]
                                                    : prev.filter((x) => x !== s.key)
                                            )
                                        }
                                    />
                                    <Text size="small">{s.label}</Text>
                                </label>
                            ))}
                        </div>
                        <Text size="xsmall" className="text-ui-fg-muted">
                            Un producto puede estar en ambos sistemas, en uno, o quedar taggeado sin sistema (inactivo).
                        </Text>
                    </div>
                    {fields.map(renderField)}
                    {error && (
                        <Text size="small" className="text-ui-fg-error">
                            {error}
                        </Text>
                    )}
                </Drawer.Body>
                <Drawer.Footer>
                    <Button variant="secondary" onClick={onClose} disabled={saving}>
                        Cancel
                    </Button>
                    <Button onClick={save} disabled={saving || missingRequired.length > 0}>
                        {missingRequired.length > 0
                            ? `Missing: ${missingRequired.map((f) => f.label).join(", ")}`
                            : saving
                              ? "Saving…"
                              : "Save"}
                    </Button>
                </Drawer.Footer>
            </Drawer.Content>
        </Drawer>
    );
}
