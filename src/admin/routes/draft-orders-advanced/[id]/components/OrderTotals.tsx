import { Container, Heading, Text } from "@medusajs/ui";
import { fmt } from "../helpers";

interface Props {
  subtotal: number;
  shippingTotal: number;
  discountTotal: number;
  taxTotal: number;
  total: number;
  itemCount: number;
  curr: string;
  /** Tax rate as a percentage (e.g. 7 for 7%). If provided shows "Tax (7%)" label. */
  taxRate?: number;
}

export const OrderTotals = ({
  subtotal,
  shippingTotal,
  discountTotal,
  taxTotal,
  total,
  itemCount,
  curr,
  taxRate,
}: Props) => {
  // Order Subtotal = only items minus discount (shipping is shown separately below)
  const orderSubtotal = subtotal - discountTotal;

  return (
    <Container className="p-0 overflow-hidden">
      <div className="px-6 py-4 border-b border-ui-border-base">
        <Heading level="h2">Order Total</Heading>
      </div>
      <div className="px-6 py-4 space-y-2">
        {/* ── Item Subtotal ── */}
        <div className="flex justify-between">
          <Text size="small" className="text-ui-fg-subtle">
            Item Subtotal
            <span className="text-ui-fg-muted ml-1 text-xs">
              {itemCount} item{itemCount !== 1 ? "s" : ""}
            </span>
          </Text>
          <Text size="small">{fmt(subtotal, curr)}</Text>
        </div>

        {/* ── Discount ── */}
        <div className="flex justify-between">
          <Text size="small" className="text-ui-fg-subtle">
            Discount
          </Text>
          <Text size="small">{fmt(discountTotal, curr)}</Text>
        </div>

        {/* ── Order Subtotal (items − discount; shipping NOT included) ── */}
        <div className="flex justify-between border-t border-ui-border-base pt-2 mt-1">
          <Text size="small" weight="plus" className="text-ui-fg-subtle">
            Order Subtotal
          </Text>
          <Text size="small" weight="plus">
            {fmt(orderSubtotal, curr)}
          </Text>
        </div>

        {/* ── Shipping (shown after subtotal) ── */}
        <div className="flex justify-between">
          <Text size="small" className="text-ui-fg-subtle">
            Shipping
          </Text>
          <Text size="small">{fmt(shippingTotal, curr)}</Text>
        </div>

        {/* ── Tax (calculated on items only, not shipping) ── */}
        <div className="flex justify-between">
          <Text size="small" className="text-ui-fg-subtle">
            {taxRate != null ? `Tax (${taxRate}%)` : "Tax"}
          </Text>
          <Text size="small">{fmt(taxTotal, curr)}</Text>
        </div>

        {/* ── Grand Total ── */}
        <div className="flex justify-between border-t border-ui-border-base pt-2 mt-1">
          <Text size="small" weight="plus">
            Total
          </Text>
          <Text size="small" weight="plus">
            {fmt(total, curr)} {curr.toUpperCase()}
          </Text>
        </div>
      </div>
    </Container>
  );
};
