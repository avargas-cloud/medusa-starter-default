/**
 * Variant Available-Since widget (product page)
 *
 * Lists all variants of the current product with a date input per variant for
 * `metadata.available_since`. This date tells the purchasing engine since
 * when the variant has been "alive" — empty months between this date and now
 * count as real zeros (drag weighted Pareto revenue down) instead of being
 * skipped as pre-life.
 *
 * Default behavior: every variant got bulk-seeded to today−395 days, so by
 * default products are treated as fully available the last 12 months. Use
 * this widget to override per genuinely-newer variants.
 *
 * Saving an empty value clears the override → engine falls back to first sale.
 */

import { defineWidgetConfig } from "@medusajs/admin-sdk";
import { DetailWidgetProps, AdminProduct } from "@medusajs/framework/types";
import {
  Container,
  Heading,
  Text,
  Input,
  Button,
  toast,
  Tooltip,
  IconButton,
} from "@medusajs/ui";
import { ArrowPath, InformationCircle } from "@medusajs/icons";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useState, useEffect, useMemo } from "react";

import { BASE_URL } from "../../lib/sdk";

type VariantWithMeta = {
  id: string;
  sku: string | null;
  title: string | null;
  metadata: Record<string, unknown> | null;
};

const VariantAvailableSinceWidget = ({
  data: productData,
}: DetailWidgetProps<AdminProduct>) => {
  const queryClient = useQueryClient();

  // Fetch product with variant metadata explicitly included.
  const { data: response, isLoading } = useQuery({
    queryFn: async () => {
      const res = await fetch(
        `${BASE_URL}/admin/products/${productData.id}?fields=variants.id,variants.sku,variants.title,variants.metadata`,
        { credentials: "include" }
      );
      if (!res.ok) throw new Error("Failed to fetch product");
      return res.json();
    },
    queryKey: ["product", productData.id, "variant-available-since"],
  });

  const variants: VariantWithMeta[] = useMemo(
    () => response?.product?.variants ?? [],
    [response]
  );

  // Local edit state per variant: variant_id → "YYYY-MM-DD"
  const [drafts, setDrafts] = useState<Record<string, string>>({});

  // Sync drafts with server state when product loads.
  useEffect(() => {
    if (variants.length === 0) return;
    setDrafts((prev) => {
      const next = { ...prev };
      for (const v of variants) {
        if (next[v.id] === undefined) {
          const cur = (v.metadata?.available_since as string | undefined) ?? "";
          next[v.id] = cur;
        }
      }
      return next;
    });
  }, [variants]);

  const saveOne = useMutation({
    mutationFn: async (input: { variantId: string; value: string | null }) => {
      const res = await fetch(
        `${BASE_URL}/admin/purchasing/variants/${input.variantId}/available-since`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "include",
          body: JSON.stringify({ available_since: input.value }),
        }
      );
      if (!res.ok) {
        const err = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(err.error ?? "Save failed");
      }
      return res.json();
    },
    onSuccess: () => {
      toast.success("available_since updated · Pareto recalculated");
      queryClient.invalidateQueries({ queryKey: ["product", productData.id] });
    },
    onError: (err) => {
      toast.error("Failed to save", { description: (err as Error).message });
    },
  });

  function handleSave(variantId: string) {
    const v = drafts[variantId] ?? "";
    saveOne.mutate({
      variantId,
      value: v.trim() === "" ? null : v.trim(),
    });
  }

  function handleDefault(variantId: string) {
    // Today − 395 days, matches the bulk-seed default.
    const d = new Date();
    d.setDate(d.getDate() - 395);
    const iso = d.toISOString().slice(0, 10);
    setDrafts((prev) => ({ ...prev, [variantId]: iso }));
  }

  function handleClear(variantId: string) {
    setDrafts((prev) => ({ ...prev, [variantId]: "" }));
  }

  if (isLoading) {
    return (
      <Container>
        <div className="px-6 py-4">
          <Text size="small" className="text-ui-fg-subtle">Loading…</Text>
        </div>
      </Container>
    );
  }

  if (variants.length === 0) {
    return (
      <Container>
        <div className="px-6 py-4">
          <Text size="small" className="text-ui-fg-subtle">No variants.</Text>
        </div>
      </Container>
    );
  }

  return (
    <Container className="divide-y p-0">
      <div className="flex items-center justify-between px-6 py-4">
        <div>
          <div className="flex items-center gap-2">
            <Heading level="h2">Available Since (Pareto)</Heading>
            <Tooltip content="Tells the purchasing engine since when each variant has existed. Empty months between this date and now count as real zeros (drag weighted revenue down). Leave empty to fall back to first sale date.">
              <IconButton size="small" variant="transparent">
                <InformationCircle />
              </IconButton>
            </Tooltip>
          </div>
          <Text size="small" className="text-ui-fg-subtle mt-1">
            Override per variant. Empty = engine uses first sale date.
          </Text>
        </div>
      </div>

      <div className="px-6 py-4">
        <div className="flex flex-col gap-3">
          {variants.map((v) => {
            const stored =
              (v.metadata?.available_since as string | undefined) ?? "";
            const draft = drafts[v.id] ?? "";
            const dirty = draft !== stored;
            return (
              <div
                key={v.id}
                className="flex items-center gap-2 flex-wrap"
              >
                <div className="min-w-[180px]">
                  <Text size="small" weight="plus">
                    {v.sku ?? v.id}
                  </Text>
                  {v.title && v.title !== v.sku ? (
                    <Text size="xsmall" className="text-ui-fg-subtle">
                      {v.title}
                    </Text>
                  ) : null}
                </div>
                <Input
                  type="date"
                  value={draft}
                  onChange={(e) =>
                    setDrafts((prev) => ({
                      ...prev,
                      [v.id]: (e.target as HTMLInputElement).value,
                    }))
                  }
                  className="w-[160px]"
                />
                <Tooltip content="Set to today − 13 months (default: treat as fully available 12 months+)">
                  <Button
                    size="small"
                    variant="transparent"
                    onClick={() => handleDefault(v.id)}
                    type="button"
                  >
                    13m+
                  </Button>
                </Tooltip>
                <Tooltip content="Clear override → engine falls back to first sale date">
                  <Button
                    size="small"
                    variant="transparent"
                    onClick={() => handleClear(v.id)}
                    type="button"
                  >
                    <ArrowPath /> Clear
                  </Button>
                </Tooltip>
                <Button
                  size="small"
                  variant={dirty ? "primary" : "secondary"}
                  disabled={!dirty || saveOne.isPending}
                  isLoading={
                    saveOne.isPending && saveOne.variables?.variantId === v.id
                  }
                  onClick={() => handleSave(v.id)}
                  type="button"
                >
                  Save
                </Button>
              </div>
            );
          })}
        </div>
      </div>
    </Container>
  );
};

export const config = defineWidgetConfig({
  zone: "product.details.after",
});

export default VariantAvailableSinceWidget;
