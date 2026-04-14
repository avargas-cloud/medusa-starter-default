import { ChevronDownMini } from "@medusajs/icons";
import { Text } from "@medusajs/ui";
import { useState, useRef, useEffect } from "react";

export interface PriceOption {
  label: string;
  amount: number;
  priceListId?: string;
}

interface PriceComboboxProps {
  value: string;
  onChange: (v: string) => void;
  onBlur?: () => void;
  onSelectOption?: (amount: number) => void;
  options?: PriceOption[];
}

export const PriceCombobox = ({
  value,
  onChange,
  onBlur,
  onSelectOption,
  options = [],
}: PriceComboboxProps) => {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  // Close on outside click
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (
        containerRef.current &&
        !containerRef.current.contains(e.target as Node)
      ) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  const defaultOptions = options.filter((o) => !o.priceListId);
  const listOptions = options.filter((o) => o.priceListId);
  const currentAmount = parseFloat(value) || 0;

  const formatAmt = (amt: number) => `$${amt.toFixed(2)}`;

  return (
    <div ref={containerRef} className="relative flex items-center">
      <div className="flex items-center border border-ui-border-base rounded-md bg-ui-bg-base focus-within:ring-1 focus-within:ring-ui-border-interactive overflow-hidden">
        <span className="px-2 text-sm text-ui-fg-muted select-none">$</span>
        <input
          type="number"
          step="0.01"
          min="0"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onBlur={() => {
            onBlur?.();
            // Small delay so dropdown clicks register first
            setTimeout(() => setOpen(false), 150);
          }}
          className="w-20 bg-transparent text-sm text-right tabular-nums outline-none py-1.5 pr-1 [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
        />
        {options.length > 0 && (
          <button
            type="button"
            tabIndex={-1}
            onMouseDown={(e) => {
              e.preventDefault();
              setOpen((o) => !o);
            }}
            className="px-1.5 py-1.5 border-l border-ui-border-base hover:bg-ui-bg-subtle text-ui-fg-muted transition-colors"
            title="Choose price type"
          >
            <ChevronDownMini
              className={`transition-transform ${open ? "rotate-180" : ""}`}
            />
          </button>
        )}
      </div>

      {/* Dropdown panel */}
      {open && options.length > 0 && (
        <div className="absolute right-0 top-full mt-1 z-50 min-w-[200px] bg-ui-bg-base border border-ui-border-base rounded-lg shadow-xl overflow-hidden">
          {/* Default prices */}
          {defaultOptions.map((opt) => {
            const isActive = Math.abs(opt.amount - currentAmount) < 0.005;
            return (
              <button
                key={opt.label}
                onMouseDown={(e) => {
                  e.preventDefault();
                  onChange(opt.amount.toFixed(2));
                  onSelectOption?.(opt.amount);
                  setOpen(false);
                }}
                className={`w-full flex items-center justify-between gap-4 px-3 py-2.5 text-left hover:bg-ui-bg-subtle transition-colors ${isActive ? "bg-ui-bg-subtle" : ""}`}
              >
                <Text
                  size="small"
                  className={
                    isActive
                      ? "font-semibold text-ui-fg-interactive"
                      : "text-ui-fg-base"
                  }
                >
                  {opt.label}
                </Text>
                <Text
                  size="small"
                  className="tabular-nums text-ui-fg-base font-medium"
                >
                  {formatAmt(opt.amount)}
                </Text>
              </button>
            );
          })}

          {/* Separator before price list options */}
          {defaultOptions.length > 0 && listOptions.length > 0 && (
            <div className="border-t border-ui-border-base mx-2 my-1" />
          )}

          {/* Price list prices (e.g. Wholesale) */}
          {listOptions.map((opt) => {
            const isActive = Math.abs(opt.amount - currentAmount) < 0.005;
            return (
              <button
                key={opt.priceListId ?? opt.label}
                onMouseDown={(e) => {
                  e.preventDefault();
                  onChange(opt.amount.toFixed(2));
                  onSelectOption?.(opt.amount);
                  setOpen(false);
                }}
                className={`w-full flex items-center justify-between gap-4 px-3 py-2.5 text-left hover:bg-ui-bg-subtle transition-colors ${isActive ? "bg-ui-bg-subtle" : ""}`}
              >
                <Text
                  size="small"
                  className={
                    isActive
                      ? "font-semibold text-ui-fg-interactive"
                      : "text-ui-fg-base"
                  }
                >
                  {opt.label}
                </Text>
                <Text
                  size="small"
                  className="tabular-nums text-ui-fg-base font-medium"
                >
                  {formatAmt(opt.amount)}
                </Text>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
};
