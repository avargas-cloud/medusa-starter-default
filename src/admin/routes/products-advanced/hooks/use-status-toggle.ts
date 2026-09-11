import { toast } from "@medusajs/ui";
import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useRef, useState } from "react";

import type { MeiliProduct } from "../../../lib/meili-types";

type ProductStatus = MeiliProduct["status"];

/**
 * The table reads from MeiliSearch, which the PG trigger
 * `trg_meili_sync_product` re-indexes through a 1-minute queue. A refetch
 * inside that window would flip a freshly-toggled row back to its old
 * status, so we keep a local override per product id and let it expire
 * once Meili has had time to catch up.
 */
const OVERRIDE_TTL_MS = 120_000;

type Override = { status: ProductStatus; expiresAt: number };

export const useStatusToggle = () => {
  const queryClient = useQueryClient();
  const [pendingIds, setPendingIds] = useState<Set<string>>(new Set());
  const [overrides, setOverrides] = useState<Record<string, Override>>({});
  const timers = useRef<Record<string, ReturnType<typeof setTimeout>>>({});

  const setPending = (id: string, on: boolean) =>
    setPendingIds((prev) => {
      const next = new Set(prev);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });

  const rememberOverride = (id: string, status: ProductStatus) => {
    setOverrides((prev) => ({
      ...prev,
      [id]: { status, expiresAt: Date.now() + OVERRIDE_TTL_MS },
    }));
    if (timers.current[id]) clearTimeout(timers.current[id]);
    timers.current[id] = setTimeout(() => {
      setOverrides((prev) => {
        const { [id]: _expired, ...rest } = prev;
        return rest;
      });
      queryClient.invalidateQueries({ queryKey: ["meili-products"] });
    }, OVERRIDE_TTL_MS);
  };

  /** Status to render: the local override wins while it is fresh. */
  const displayStatus = useCallback(
    (product: MeiliProduct): ProductStatus => {
      const o = overrides[product.id];
      return o && o.expiresAt > Date.now() ? o.status : product.status;
    },
    [overrides]
  );

  const toggleStatus = async (product: MeiliProduct) => {
    if (pendingIds.has(product.id)) return;
    const current = displayStatus(product);
    const next: ProductStatus = current === "published" ? "draft" : "published";

    setPending(product.id, true);
    try {
      // Native Medusa route — same path the product editor uses, so the
      // usual product.updated subscribers (thumbnail, Meili) fire as well.
      const res = await fetch(`/admin/products/${product.id}`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: next }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body?.message || `HTTP ${res.status}`);
      }
      const { product: saved } = (await res.json()) as {
        product?: { status?: ProductStatus };
      };
      if (saved?.status !== next) {
        throw new Error(`server returned status "${saved?.status ?? "?"}"`);
      }

      rememberOverride(product.id, next);
      queryClient.setQueriesData<{ hits: MeiliProduct[] } | undefined>(
        { queryKey: ["meili-products"] },
        (old) =>
          old
            ? {
                ...old,
                hits: old.hits.map((h) =>
                  h.id === product.id ? { ...h, status: next } : h
                ),
              }
            : old
      );
      toast.success(next === "published" ? "Published" : "Moved to draft", {
        description: product.title,
      });
    } catch (err) {
      toast.error("Status not changed", {
        description: `${product.title}: ${
          err instanceof Error ? err.message : "unknown error"
        }`,
      });
    } finally {
      setPending(product.id, false);
    }
  };

  return { toggleStatus, displayStatus, pendingIds };
};
