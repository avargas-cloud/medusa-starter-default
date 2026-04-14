import { XMark } from "@medusajs/icons";
import { Table, Badge } from "@medusajs/ui";
import { useQuery } from "@tanstack/react-query";

interface LocationLevel {
  id: string;
  location_id: string;
  stocked_quantity: number;
  reserved_quantity: number;
  available_quantity: number;
  // Medusa v2: stock_locations is an array (dashboard source line 164701)
  stock_locations?: Array<{ id: string; name: string }>;
}

interface InventoryStockModalProps {
  open: boolean;
  onClose: () => void;
  inventoryItemId: string;
  itemTitle: string;
  sku: string;
}

/**
 * Compact centered overlay showing stock levels per location.
 * Opens when clicking Reserved, In Stock, or Available cells.
 * Data: GET /admin/inventory-items/{id}/location-levels?fields=+stock_locations.id,+stock_locations.name
 * Field format confirmed from Medusa dashboard source (location-list-table.tsx line 164833).
 */
export const InventoryStockModal = ({
  open,
  onClose,
  inventoryItemId,
  itemTitle,
  sku,
}: InventoryStockModalProps) => {
  const { data, isLoading } = useQuery({
    queryKey: ["inventory-location-levels", inventoryItemId],
    queryFn: async () => {
      const res = await fetch(
        `/admin/inventory-items/${inventoryItemId}/location-levels?fields=+stock_locations.id,+stock_locations.name`,
        { credentials: "include" }
      );
      if (!res.ok) throw new Error("Failed to fetch location levels");
      return res.json();
    },
    enabled: open && !!inventoryItemId,
    staleTime: 10_000,
  });

  const levels: LocationLevel[] = data?.inventory_levels ?? [];

  const getLocationName = (level: LocationLevel) =>
    level.stock_locations?.[0]?.name ?? level.location_id;

  const totalStocked = levels.reduce(
    (s, l) => s + (l.stocked_quantity ?? 0),
    0
  );
  const totalReserved = levels.reduce(
    (s, l) => s + (l.reserved_quantity ?? 0),
    0
  );
  const totalAvailable = levels.reduce(
    (s, l) => s + (l.available_quantity ?? 0),
    0
  );

  if (!open) return null;

  return (
    // Backdrop
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
      onClick={onClose}
    >
      {/* Card — click inside doesn't close */}
      <div
        className="bg-ui-bg-base border border-ui-border-base rounded-xl shadow-2xl w-full max-w-lg mx-4"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-ui-border-base">
          <div>
            <p className="txt-compact-small text-ui-fg-muted font-mono">
              {sku}
            </p>
            <p className="txt-compact-medium font-semibold text-ui-fg-base truncate max-w-sm">
              {itemTitle}
            </p>
          </div>
          <button
            onClick={onClose}
            className="text-ui-fg-muted hover:text-ui-fg-base transition-colors p-1"
          >
            <XMark />
          </button>
        </div>

        {/* Body */}
        <div className="p-4">
          {isLoading ? (
            <div className="flex items-center justify-center h-20 text-ui-fg-muted text-sm">
              Loading...
            </div>
          ) : levels.length === 0 ? (
            <div className="flex items-center justify-center h-20 text-ui-fg-muted text-sm">
              No location levels found for this item.
            </div>
          ) : (
            <Table>
              <Table.Header>
                <Table.Row>
                  <Table.HeaderCell>Location</Table.HeaderCell>
                  <Table.HeaderCell className="text-right">
                    Reserved
                  </Table.HeaderCell>
                  <Table.HeaderCell className="text-right">
                    In Stock
                  </Table.HeaderCell>
                  <Table.HeaderCell className="text-right">
                    Available
                  </Table.HeaderCell>
                </Table.Row>
              </Table.Header>
              <Table.Body>
                {levels.map((level) => (
                  <Table.Row key={level.id}>
                    <Table.Cell className="font-medium text-ui-fg-base">
                      {getLocationName(level)}
                    </Table.Cell>
                    <Table.Cell className="text-right text-ui-fg-muted">
                      {level.reserved_quantity ?? 0}
                    </Table.Cell>
                    <Table.Cell className="text-right font-medium">
                      {level.stocked_quantity ?? 0}
                    </Table.Cell>
                    <Table.Cell className="text-right">
                      {(level.available_quantity ?? 0) > 0 ? (
                        <span className="font-medium text-ui-fg-interactive">
                          {level.available_quantity}
                        </span>
                      ) : (
                        <Badge color="red" size="small">
                          0
                        </Badge>
                      )}
                    </Table.Cell>
                  </Table.Row>
                ))}
              </Table.Body>
              {/* Totals only when multiple locations */}
              {levels.length > 1 && (
                <tfoot>
                  <tr className="border-t border-ui-border-base bg-ui-bg-subtle">
                    <td className="px-4 py-2 text-sm font-semibold text-ui-fg-subtle">
                      Total
                    </td>
                    <td className="px-4 py-2 text-sm text-right text-ui-fg-muted">
                      {totalReserved}
                    </td>
                    <td className="px-4 py-2 text-sm text-right font-semibold">
                      {totalStocked}
                    </td>
                    <td className="px-4 py-2 text-sm text-right font-semibold text-ui-fg-interactive">
                      {totalAvailable}
                    </td>
                  </tr>
                </tfoot>
              )}
            </Table>
          )}
        </div>
      </div>
    </div>
  );
};
