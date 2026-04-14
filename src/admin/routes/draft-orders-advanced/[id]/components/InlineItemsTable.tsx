import { MagnifyingGlass, XMark, Plus, Minus, Trash } from "@medusajs/icons";
import { Text } from "@medusajs/ui";
import { useState, useRef, useEffect, useCallback } from "react";

import { fmt } from "../helpers";

import { PriceCombobox, PriceOption } from "./PriceCombobox";

interface VariantResult {
  id: string;
  title: string;
  sku?: string;
  variantTitle?: string;
  thumbnail?: string;
  salesDescription?: string;
  prices?: PriceOption[];
  /** Per-location available stock */
  locations?: { locationName: string; available: number }[];
}

interface Props {
  items: any[];
  curr: string;
  invQuery: string;
  invResults: VariantResult[];
  itemQtys: Record<string, number>;
  setItemQtys: (v: any) => void;
  itemPrices: Record<string, string>;
  setItemPrices: (v: any) => void;
  searchInvItems: (q: string) => void;
  handleAddItem: (variantId: string, overridePrice?: number) => Promise<void>;
  handleUpdateItem: (itemId: string) => Promise<void>;
  handleRemoveItem: (itemId: string) => Promise<void>;
  itemSaving: boolean;
  customerPrices: Record<string, PriceOption[]>;
  customerIsWholesale?: boolean;
}

const AUTOSAVE_DELAY = 3000; // 3 seconds debounce

// Warehouse icon SVG (not always available in @medusajs/icons)
const WarehouseIcon = () => (
  <svg
    width="14"
    height="14"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
    <polyline points="9,22 9,12 15,12 15,22" />
  </svg>
);

export const InlineItemsTable = ({
  items,
  curr,
  invQuery,
  invResults,
  itemQtys,
  setItemQtys,
  itemPrices,
  setItemPrices,
  searchInvItems,
  handleAddItem,
  handleUpdateItem,
  handleRemoveItem,
  itemSaving,
  customerPrices,
  customerIsWholesale,
}: Props) => {
  const searchRef = useRef<HTMLInputElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const [showDropdown, setShowDropdown] = useState(false);
  const [dropPos, setDropPos] = useState<{
    top: number;
    left: number;
    width: number;
  } | null>(null);

  // Track pending auto-save timers per item
  const autoSaveTimers = useRef<Record<string, ReturnType<typeof setTimeout>>>(
    {}
  );
  // Track which items are "dirty" (have unsaved changes)
  const [savingItems, setSavingItems] = useState<Set<string>>(new Set());
  const [savedItems, setSavedItems] = useState<Set<string>>(new Set());

  // ── Stock popover state ──────────────────────────────────────────────────
  const [stockPopover, setStockPopover] = useState<{
    itemId: string;
    pos: { top: number; left: number };
    locations: { locationName: string; available: number }[];
  } | null>(null);
  const [stockLoading, setStockLoading] = useState<string | null>(null);
  const stockPopoverRef = useRef<HTMLDivElement>(null);

  const fetchItemStock = async (item: any, btnEl: HTMLButtonElement) => {
    const itemId = item.id;
    const sku = item.variant?.sku;

    // Toggle off if same item
    if (stockPopover?.itemId === itemId) {
      setStockPopover(null);
      return;
    }

    setStockLoading(itemId);
    setStockPopover(null);

    try {
      // Resolve stock location names
      const locationNameMap: Record<string, string> = {};
      try {
        const slRes = await fetch(`/admin/stock-locations?limit=100`, {
          credentials: "include",
        });
        if (slRes.ok) {
          const { stock_locations } = await slRes.json();
          for (const sl of stock_locations ?? []) {
            if (sl.id && sl.name) locationNameMap[sl.id] = sl.name;
          }
        }
      } catch {
        /* best-effort */
      }

      // Find inventory item by SKU
      const invRes = await fetch(
        `/admin/inventory-items?${sku ? `sku[]=${encodeURIComponent(sku)}` : `limit=1`}&limit=10`,
        { credentials: "include" }
      );
      if (!invRes.ok) throw new Error("inv fetch failed");
      const { inventory_items } = await invRes.json();

      const locations: { locationName: string; available: number }[] = [];

      for (const inv of inventory_items ?? []) {
        const levRes = await fetch(
          `/admin/inventory-items/${inv.id}/location-levels?limit=50`,
          { credentials: "include" }
        );
        if (!levRes.ok) continue;
        const { inventory_levels } = await levRes.json();
        for (const lev of inventory_levels ?? []) {
          const locId: string = lev.location_id ?? "";
          const locName = locationNameMap[locId] ?? (locId || "Warehouse");
          const available =
            (lev.stocked_quantity ?? 0) - (lev.reserved_quantity ?? 0);
          locations.push({ locationName: locName, available });
        }
      }

      const rect = btnEl.getBoundingClientRect();
      setStockPopover({
        itemId,
        pos: { top: rect.bottom + 6, left: rect.left + rect.width / 2 },
        locations,
      });
    } catch {
      /* show nothing */
    } finally {
      setStockLoading(null);
    }
  };

  // Close stock popover on outside click
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (
        stockPopoverRef.current &&
        !stockPopoverRef.current.contains(e.target as Node)
      ) {
        setStockPopover(null);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  const triggerAutoSave = useCallback(
    (itemId: string) => {
      // Skip autosave for optimistic items — they don't have a real ID yet
      if (itemId.startsWith("optimistic-")) return;
      if (autoSaveTimers.current[itemId])
        clearTimeout(autoSaveTimers.current[itemId]);
      autoSaveTimers.current[itemId] = setTimeout(async () => {
        setSavingItems((prev) => new Set([...prev, itemId]));
        await handleUpdateItem(itemId);
        setSavingItems((prev) => {
          const s = new Set(prev);
          s.delete(itemId);
          return s;
        });
        setSavedItems((prev) => new Set([...prev, itemId]));
        setTimeout(() => {
          setSavedItems((prev) => {
            const s = new Set(prev);
            s.delete(itemId);
            return s;
          });
        }, 2000);
      }, AUTOSAVE_DELAY);
    },
    [handleUpdateItem]
  );

  const saveOnBlur = useCallback(
    async (itemId: string) => {
      if (autoSaveTimers.current[itemId]) {
        clearTimeout(autoSaveTimers.current[itemId]);
        delete autoSaveTimers.current[itemId];
        setSavingItems((prev) => new Set([...prev, itemId]));
        await handleUpdateItem(itemId);
        setSavingItems((prev) => {
          const s = new Set(prev);
          s.delete(itemId);
          return s;
        });
        setSavedItems((prev) => new Set([...prev, itemId]));
        setTimeout(() => {
          setSavedItems((prev) => {
            const s = new Set(prev);
            s.delete(itemId);
            return s;
          });
        }, 2000);
      }
    },
    [handleUpdateItem]
  );

  useEffect(() => {
    return () => {
      Object.values(autoSaveTimers.current).forEach(clearTimeout);
    };
  }, []);

  // Compute dropdown fixed position when results arrive
  useEffect(() => {
    if (invResults.length > 0) {
      setShowDropdown(true);
      if (searchRef.current) {
        const rect =
          searchRef.current
            .closest(".search-container")
            ?.getBoundingClientRect() ??
          searchRef.current.getBoundingClientRect();
        setDropPos({
          top: rect.bottom + 4,
          left: rect.left,
          width: rect.width,
        });
      }
    } else {
      setShowDropdown(false);
    }
  }, [invResults]);

  // Close dropdown on outside click
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (
        dropdownRef.current &&
        !dropdownRef.current.contains(e.target as Node) &&
        searchRef.current &&
        !searchRef.current.contains(e.target as Node)
      )
        setShowDropdown(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  return (
    <div>
      {/* ── Search box ── */}
      <div className="search-container px-6 py-3 border-b border-ui-border-base bg-ui-bg-subtle">
        <div className="relative">
          <div className="flex items-center gap-2 border border-ui-border-base rounded-md bg-ui-bg-base px-3 py-2 focus-within:ring-1 focus-within:ring-ui-border-interactive">
            <MagnifyingGlass className="text-ui-fg-muted shrink-0" />
            <input
              ref={searchRef}
              value={invQuery}
              onChange={(e) => {
                searchInvItems(e.target.value);
                if (!e.target.value) setShowDropdown(false);
              }}
              onFocus={() => {
                if (invResults.length > 0) setShowDropdown(true);
              }}
              placeholder="Search products by name or SKU to add..."
              className="flex-1 bg-transparent text-sm text-ui-fg-base outline-none placeholder:text-ui-fg-muted"
            />
            {invQuery && (
              <button
                onClick={() => {
                  searchInvItems("");
                  setShowDropdown(false);
                }}
                className="text-ui-fg-muted hover:text-ui-fg-base"
              >
                <XMark />
              </button>
            )}
          </div>

          {/* Dropdown: position:fixed escapes any overflow:hidden ancestor */}
          {showDropdown && invResults.length > 0 && dropPos && (
            <div
              ref={dropdownRef}
              style={{
                position: "fixed",
                top: dropPos.top,
                left: dropPos.left,
                width: dropPos.width,
                zIndex: 9999,
              }}
              className="bg-ui-bg-base border-2 border-ui-border-interactive rounded-lg shadow-2xl max-h-[440px] overflow-y-auto ring-1 ring-black/10"
            >
              {invResults.map((v) => {
                const prices = (v.prices ?? []) as PriceOption[];
                const defaultP =
                  prices.find((p) => !p.priceListId) ?? prices[0];
                const contractorP = prices.find((p) => p.priceListId);
                return (
                  <button
                    key={v.id}
                    disabled={itemSaving}
                    className="w-full flex items-center gap-3 px-3 py-2.5 hover:bg-ui-bg-subtle border-b border-ui-border-base last:border-0 text-left disabled:opacity-50"
                    onClick={() => {
                      // Wholesale customers get the contractor (price list) price by default;
                      // Retail/Standard customers get the default (retail) price by default.
                      const price =
                        customerIsWholesale && contractorP
                          ? contractorP
                          : (defaultP ?? contractorP);
                      handleAddItem(v.id, price?.amount);
                      setShowDropdown(false);
                    }}
                  >
                    {/* Thumbnail */}
                    {v.thumbnail ? (
                      <img
                        src={v.thumbnail}
                        alt=""
                        className="w-9 h-9 object-cover rounded border border-ui-border-base shrink-0"
                      />
                    ) : (
                      <div className="w-9 h-9 bg-ui-bg-subtle rounded border border-ui-border-base shrink-0 flex items-center justify-center text-ui-fg-muted text-xs">
                        IMG
                      </div>
                    )}

                    {/* Product info — flex-1 takes all remaining space on the left */}
                    <div className="flex-1 min-w-0">
                      {/* Sales description is the primary label (correct per-SKU from QB) */}
                      <Text
                        size="small"
                        weight="plus"
                        className="truncate block leading-snug"
                      >
                        {v.salesDescription ?? v.title}
                      </Text>
                      {/* Show the product title as a subtitle so the user has context */}
                      {!v.salesDescription && v.variantTitle && (
                        <Text
                          size="xsmall"
                          className="text-ui-fg-subtle truncate block"
                        >
                          {v.variantTitle}
                        </Text>
                      )}
                      {v.sku && (
                        <Text
                          size="xsmall"
                          className="text-ui-fg-muted font-mono"
                        >
                          {v.sku}
                        </Text>
                      )}
                    </div>

                    {/* Availability — flex-1 so it truly centers between product info and prices */}
                    <div className="flex-1 text-center">
                      {v.locations && v.locations.length > 0 && (
                        <>
                          <p className="text-[9px] font-semibold text-ui-fg-muted uppercase tracking-wide leading-none mb-0.5">
                            Availability
                          </p>
                          {v.locations.map((loc, i) => (
                            <p
                              key={i}
                              className={`text-[10px] leading-tight ${
                                loc.available <= 0
                                  ? "text-red-400"
                                  : loc.available <= 5
                                    ? "text-orange-400"
                                    : "text-green-400"
                              }`}
                            >
                              <span className="text-ui-fg-muted">
                                {loc.locationName}:
                              </span>{" "}
                              {loc.available <= 0
                                ? "0 units"
                                : `${loc.available} units`}
                            </p>
                          ))}
                        </>
                      )}
                    </div>

                    {/* Prices — right-aligned, show ✓ on the customer-appropriate price */}
                    <div className="text-right shrink-0 min-w-[8rem]">
                      {defaultP && (
                        <Text
                          size="xsmall"
                          className={`block ${!customerIsWholesale ? "text-ui-fg-interactive font-medium" : "text-ui-fg-muted"}`}
                        >
                          {fmt(defaultP.amount, "usd")}
                          {!customerIsWholesale && " ✓"}
                        </Text>
                      )}
                      {contractorP && (
                        <Text
                          size="xsmall"
                          className={`block ${customerIsWholesale ? "text-ui-fg-interactive font-medium" : "text-ui-fg-muted"}`}
                        >
                          {contractorP.label ?? "Wholesale"}:{" "}
                          {fmt(contractorP.amount, "usd")}
                          {customerIsWholesale && " ✓"}
                        </Text>
                      )}
                    </div>
                  </button>
                );
              })}
            </div>
          )}
        </div>
      </div>

      {/* ── Column headers ── */}
      {items.length > 0 && (
        <div className="grid grid-cols-[2.5rem_1fr_2rem_10rem_6rem_5.5rem_1.5rem] gap-x-3 px-6 py-2 border-b border-ui-border-base">
          <div />
          <Text
            size="xsmall"
            weight="plus"
            className="text-ui-fg-muted uppercase tracking-wide"
          >
            Item
          </Text>
          <div />
          <Text
            size="xsmall"
            weight="plus"
            className="text-ui-fg-muted uppercase tracking-wide text-right"
          >
            Price
          </Text>
          <Text
            size="xsmall"
            weight="plus"
            className="text-ui-fg-muted uppercase tracking-wide text-center"
          >
            Qty
          </Text>
          <Text
            size="xsmall"
            weight="plus"
            className="text-ui-fg-muted uppercase tracking-wide text-right"
          >
            Total
          </Text>
          <div />
        </div>
      )}

      {/* ── Item rows ── */}
      {items.length === 0 ? (
        <div className="px-6 py-8 text-center">
          <Text size="small" className="text-ui-fg-subtle">
            No items yet. Search above to add products.
          </Text>
        </div>
      ) : (
        [...items]
          .sort((a: any, b: any) => {
            // Respect sort_order saved by POS drag-to-reorder
            const aOrder = a.metadata?.sort_order ?? 9999;
            const bOrder = b.metadata?.sort_order ?? 9999;
            return aOrder - bOrder;
          })
          .map((item) => {
            const qty = itemQtys[item.id] ?? item.quantity;
            const rawUnitPrice = item.unit_price ?? 0;
            const priceStr =
              itemPrices[item.id] ??
              parseFloat(String(rawUnitPrice)).toFixed(2);
            const price = parseFloat(priceStr) || 0;
            const options =
              customerPrices[item.variant?.id ?? item.variant_id ?? ""] ?? [];
            const subtotal = price * qty;
            const isSaving = savingItems.has(item.id);
            const isSaved = savedItems.has(item.id);
            const isLoadingStock = stockLoading === item.id;
            const hasPopover = stockPopover?.itemId === item.id;

            // Line discount rehydration from metadata (persisted by POS on save)
            const lineDiscount = item.metadata?.line_discount as
              | { type: "percent" | "fixed"; value: number }
              | undefined;
            const originalUnitPrice = item.metadata?.original_unit_price as
              | number
              | undefined;
            const hasLineDiscount =
              !!lineDiscount && !!originalUnitPrice && lineDiscount.value > 0;
            const discountLabel = hasLineDiscount
              ? lineDiscount!.type === "percent"
                ? `${lineDiscount!.value}%`
                : `-$${lineDiscount!.value.toFixed(2)}`
              : null;

            return (
              <div
                key={item.id}
                className="group grid grid-cols-[2.5rem_1fr_2rem_10rem_6rem_5.5rem_1.5rem] gap-x-3 items-center px-6 py-3 border-b border-ui-border-base last:border-0 hover:bg-ui-bg-subtle transition-colors"
              >
                {/* Thumbnail */}
                {item.thumbnail ? (
                  <img
                    src={item.thumbnail}
                    alt=""
                    className="w-9 h-9 object-cover rounded border border-ui-border-base"
                  />
                ) : (
                  <div className="w-9 h-9 bg-ui-bg-subtle rounded border border-ui-border-base flex items-center justify-center text-xs text-ui-fg-muted">
                    —
                  </div>
                )}

                {/* Title / SKU */}
                <div className="min-w-0">
                  <Text
                    size="small"
                    weight="plus"
                    className="block leading-tight"
                  >
                    {(item.metadata?.sales_description as string | undefined) ??
                      item.title}
                  </Text>
                  {item.variant?.title && (
                    <Text size="xsmall" className="text-ui-fg-subtle">
                      {item.variant.title}
                    </Text>
                  )}
                  {item.variant?.sku && (
                    <Text size="xsmall" className="text-ui-fg-muted font-mono">
                      {item.variant.sku}
                    </Text>
                  )}
                </div>

                {/* Stock availability button */}
                <div className="flex items-center justify-center">
                  <button
                    title="View stock availability"
                    onClick={(e) =>
                      fetchItemStock(item, e.currentTarget as HTMLButtonElement)
                    }
                    className={`w-6 h-6 flex items-center justify-center rounded transition-colors ${
                      hasPopover
                        ? "text-ui-fg-interactive bg-ui-bg-interactive-hover"
                        : "text-ui-fg-muted hover:text-ui-fg-base hover:bg-ui-bg-base"
                    } ${isLoadingStock ? "animate-pulse" : ""}`}
                  >
                    <WarehouseIcon />
                  </button>
                </div>

                {/* Price — auto-saves on blur or after 3s of inactivity */}
                <div className="flex flex-col items-end gap-0.5">
                  {/* Discount indicator badge — shown when a POS line discount was applied */}
                  {hasLineDiscount && (
                    <div className="flex items-center gap-1">
                      <span className="text-[10px] text-ui-fg-muted line-through tabular-nums">
                        ${originalUnitPrice!.toFixed(2)}
                      </span>
                      <span className="text-[9px] font-bold bg-green-100 text-green-700 rounded px-1 py-0.5 leading-none">
                        {discountLabel}
                      </span>
                    </div>
                  )}
                  <div className="flex items-center justify-end gap-1">
                    {isSaving && (
                      <span className="text-[10px] text-ui-fg-muted animate-pulse">
                        saving…
                      </span>
                    )}
                    {isSaved && !isSaving && (
                      <span className="text-[10px] text-ui-fg-interactive">
                        ✓
                      </span>
                    )}
                    <PriceCombobox
                      value={priceStr}
                      onChange={(v) => {
                        setItemPrices((p: any) => ({ ...p, [item.id]: v }));
                        triggerAutoSave(item.id);
                      }}
                      onBlur={() => saveOnBlur(item.id)}
                      options={options}
                      onSelectOption={(amount) => {
                        setItemPrices((p: any) => ({
                          ...p,
                          [item.id]: amount.toFixed(2),
                        }));
                        if (autoSaveTimers.current[item.id]) {
                          clearTimeout(autoSaveTimers.current[item.id]);
                          delete autoSaveTimers.current[item.id];
                        }
                        setTimeout(() => handleUpdateItem(item.id), 50);
                      }}
                    />
                  </div>
                </div>

                {/* Qty stepper */}
                <div className="flex items-center gap-1 justify-center">
                  <button
                    onClick={() => {
                      setItemQtys((q: any) => ({
                        ...q,
                        [item.id]: Math.max(
                          1,
                          (q[item.id] ?? item.quantity) - 1
                        ),
                      }));
                      triggerAutoSave(item.id);
                    }}
                    disabled={itemSaving || isSaving}
                    className="w-5 h-5 flex items-center justify-center border border-ui-border-base rounded hover:bg-ui-bg-base text-ui-fg-muted disabled:opacity-40 disabled:cursor-not-allowed"
                  >
                    <Minus />
                  </button>
                  <span className="w-7 text-center text-sm font-medium tabular-nums">
                    {qty}
                  </span>
                  <button
                    onClick={() => {
                      setItemQtys((q: any) => ({
                        ...q,
                        [item.id]: (q[item.id] ?? item.quantity) + 1,
                      }));
                      triggerAutoSave(item.id);
                    }}
                    disabled={itemSaving || isSaving}
                    className="w-5 h-5 flex items-center justify-center border border-ui-border-base rounded hover:bg-ui-bg-base text-ui-fg-muted disabled:opacity-40 disabled:cursor-not-allowed"
                  >
                    <Plus />
                  </button>
                </div>

                {/* Row total — unit_price is already discounted, so subtotal is correct */}
                <div className="text-right min-w-[5rem]">
                  {hasLineDiscount && (
                    <Text
                      size="xsmall"
                      className="block text-ui-fg-muted line-through tabular-nums"
                    >
                      {fmt(originalUnitPrice! * qty, curr)}
                    </Text>
                  )}
                  <Text
                    size="small"
                    className={`tabular-nums ${hasLineDiscount ? "text-green-700 font-semibold" : ""}`}
                  >
                    {fmt(subtotal, curr)}
                  </Text>
                </div>

                {/* Delete button */}
                <button
                  onClick={() => handleRemoveItem(item.id)}
                  disabled={itemSaving || isSaving}
                  title="Remove item"
                  className="w-5 h-5 flex items-center justify-center text-ui-fg-muted hover:text-ui-fg-error hover:bg-ui-bg-subtle rounded opacity-0 group-hover:opacity-100 transition-opacity disabled:opacity-50"
                >
                  <Trash />
                </button>
              </div>
            );
          })
      )}

      {/* ── Stock availability popover ── */}
      {stockPopover && (
        <div
          ref={stockPopoverRef}
          style={{
            position: "fixed",
            top: stockPopover.pos.top,
            left: stockPopover.pos.left,
            transform: "translateX(-50%)",
            zIndex: 9999,
          }}
          className="bg-ui-bg-overlay border border-ui-border-base rounded-lg shadow-2xl p-3 min-w-[180px] ring-1 ring-black/10"
        >
          {/* Arrow */}
          <div
            style={{
              position: "absolute",
              top: -5,
              left: "50%",
              transform: "translateX(-50%) rotate(45deg)",
              width: 10,
              height: 10,
            }}
            className="bg-ui-bg-overlay border-l border-t border-ui-border-base"
          />
          <p className="text-[9px] font-semibold text-ui-fg-muted uppercase tracking-wide mb-1.5">
            Availability
          </p>
          {stockPopover.locations.length === 0 ? (
            <p className="text-[11px] text-ui-fg-muted">No stock data found</p>
          ) : (
            stockPopover.locations.map((loc, i) => (
              <div
                key={i}
                className="flex items-center justify-between gap-4 py-0.5"
              >
                <span className="text-[11px] text-ui-fg-subtle">
                  {loc.locationName}
                </span>
                <span
                  className={`text-[11px] font-semibold tabular-nums ${
                    loc.available <= 0
                      ? "text-red-400"
                      : loc.available <= 5
                        ? "text-orange-400"
                        : "text-green-400"
                  }`}
                >
                  {loc.available <= 0 ? "0" : loc.available} units
                </span>
              </div>
            ))
          )}
        </div>
      )}
    </div>
  );
};
