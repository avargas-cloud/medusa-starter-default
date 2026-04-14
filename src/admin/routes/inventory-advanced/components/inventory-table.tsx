import {
  EllipsisHorizontal,
  PencilSquare,
  Trash,
  TagSolid,
  TriangleUpMini,
  TriangleDownMini,
} from "@medusajs/icons";
import { Table, Badge, DropdownMenu, IconButton, clx } from "@medusajs/ui";
import { useState } from "react";
import { useNavigate, Link } from "react-router-dom";

import { MeiliInventoryItem } from "../../../lib/meili-types";
import type { PriceList } from "../hooks/use-feature-flags";

import { InventoryStockModal } from "./inventory-stock-modal";

interface InventoryTableProps {
  items: MeiliInventoryItem[];
  isLoading: boolean;
  sortBy?: string;
  onSortChange?: (sort: string) => void;
  enableDynamicPricing?: boolean;
  priceLists?: PriceList[];
}

/**
 * Component: Inventory Table
 *
 * Columns: Image, Title, SKU, Reserved, In Stock, Available, Retail Price [+ price list columns], Actions
 * - Reserved / In Stock / Available → click opens InventoryStockModal
 * - Retail Price → opens /products/{id}/variants/{id}/prices in new tab
 * - Price list columns → opens /price-lists/{id}/products/edit?ids[]={id} in new tab
 */
export const InventoryTable = ({
  items,
  isLoading,
  sortBy,
  onSortChange,
  enableDynamicPricing = false,
  priceLists = [],
}: InventoryTableProps) => {
  const navigate = useNavigate();
  const [selectedStockItem, setSelectedStockItem] = useState<{
    id: string;
    title: string;
    sku: string;
  } | null>(null);

  const formatPrice = (
    price: number | null | undefined,
    currencyCode: string
  ) => {
    if (price === null || price === undefined || isNaN(price))
      return `${currencyCode} $0.00`;
    return `${currencyCode} $${price.toFixed(2)}`;
  };

  const openStockModal = (item: MeiliInventoryItem) =>
    setSelectedStockItem({ id: item.id, title: item.title, sku: item.sku });

  const goToInventoryItem = (id: string) => navigate(`/inventory/${id}`);
  const goToVariantEdit = (
    productId: string | null,
    variantId: string | null
  ) => {
    if (!productId || !variantId) return;
    navigate(`/products/${productId}/variants/${variantId}`);
  };

  const handleHeaderClick = (column: string) => {
    if (!onSortChange) return;
    if (sortBy?.startsWith(column)) {
      const direction = sortBy.endsWith("asc") ? "desc" : "asc";
      onSortChange(`${column}:${direction}`);
    } else {
      onSortChange(`${column}:asc`);
    }
  };

  const SortIndicator = ({ column }: { column: string }) => {
    if (!sortBy?.startsWith(column)) return <div className="w-4 h-4 ml-1" />;
    return sortBy.endsWith("asc") ? (
      <TriangleUpMini className="w-4 h-4 ml-1 text-ui-fg-interactive" />
    ) : (
      <TriangleDownMini className="w-4 h-4 ml-1 text-ui-fg-interactive" />
    );
  };

  const HeaderCell = ({
    column,
    children,
    className,
  }: {
    column: string;
    children: React.ReactNode;
    className?: string;
  }) => (
    <Table.HeaderCell
      className={clx(
        "cursor-pointer hover:bg-ui-bg-subtle-hover transition-colors select-none whitespace-nowrap",
        className
      )}
      onClick={() => handleHeaderClick(column)}
    >
      <div className="flex items-center">
        {children}
        <SortIndicator column={column} />
      </div>
    </Table.HeaderCell>
  );

  // Numeric button cell — compact, clickable, opens stock modal
  const StockCell = ({
    value,
    colorZero = false,
    item,
  }: {
    value: number;
    colorZero?: boolean;
    item: MeiliInventoryItem;
  }) => (
    <Table.Cell className="w-16 text-center">
      <button
        onClick={() => openStockModal(item)}
        className="flex items-center justify-center w-full h-full hover:text-ui-fg-interactive transition-colors cursor-pointer"
      >
        {value > 0 ? (
          <span className="text-ui-fg-base font-medium text-sm">{value}</span>
        ) : colorZero ? (
          <Badge color="red" size="small">
            0
          </Badge>
        ) : (
          <span className="text-ui-fg-disabled text-sm">0</span>
        )}
      </button>
    </Table.Cell>
  );

  const emptyColCount = 6 + (enableDynamicPricing ? priceLists.length : 0) + 1;

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="text-ui-fg-subtle">Loading...</div>
      </div>
    );
  }

  return (
    <>
      {/* overflow-x-auto enables horizontal scroll when extra price columns are added */}
      <div className="flex-1 overflow-auto">
        <Table>
          <Table.Header>
            <Table.Row>
              <Table.HeaderCell className="w-16 whitespace-nowrap">
                Image
              </Table.HeaderCell>
              <HeaderCell column="title" className="max-w-[440px]">
                Title
              </HeaderCell>
              <HeaderCell column="sku">SKU</HeaderCell>
              {/* Numeric columns — compact width */}
              <HeaderCell column="totalStock" className="w-20 text-center">
                In Stock
              </HeaderCell>
              <HeaderCell column="totalReserved" className="w-20 text-center">
                Reserved
              </HeaderCell>
              <Table.HeaderCell className="w-20 text-center whitespace-nowrap select-none">
                Available
              </Table.HeaderCell>
              {/* Always: Retail Price */}
              <HeaderCell column="price">Retail Price</HeaderCell>
              {/* Dynamic price list columns */}
              {enableDynamicPricing &&
                priceLists.map((pl) => (
                  <Table.HeaderCell
                    key={pl.id}
                    className="whitespace-nowrap text-ui-fg-subtle"
                  >
                    {pl.title}
                  </Table.HeaderCell>
                ))}
              <Table.HeaderCell className="w-12" />
            </Table.Row>
          </Table.Header>
          <Table.Body>
            {items.length === 0 ? (
              <Table.Row>
                <Table.Cell
                  className="text-center text-ui-fg-subtle py-8"
                  // @ts-ignore — colSpan valid HTML
                  colSpan={emptyColCount}
                >
                  No inventory items found
                </Table.Cell>
              </Table.Row>
            ) : (
              items.map((item) => {
                const available = Math.max(
                  0,
                  item.totalStock - item.totalReserved
                );
                return (
                  <Table.Row key={item.id}>
                    {/* Thumbnail */}
                    <Table.Cell>
                      <div className="h-10 w-10 rounded-md overflow-hidden bg-ui-bg-subtle flex items-center justify-center">
                        {item.thumbnail ? (
                          <img
                            src={item.thumbnail}
                            alt={item.title}
                            className="h-full w-full object-cover"
                          />
                        ) : (
                          <TagSolid className="text-ui-fg-muted" />
                        )}
                      </div>
                    </Table.Cell>

                    {/* Title */}
                    <Table.Cell className="max-w-[440px]">
                      <Link
                        to={`/inventory/${item.id}`}
                        className="flex items-center w-full h-full font-medium text-ui-fg-base hover:text-ui-fg-interactive transition-colors truncate max-w-[440px]"
                      >
                        {item.title}
                      </Link>
                    </Table.Cell>

                    {/* SKU */}
                    <Table.Cell>
                      <Link
                        to={`/inventory/${item.id}`}
                        className="flex items-center w-full h-full font-mono text-sm text-ui-fg-subtle hover:text-ui-fg-interactive transition-colors truncate"
                      >
                        {item.sku}
                      </Link>
                    </Table.Cell>

                    {/* In Stock — opens stock modal */}
                    <StockCell value={item.totalStock} colorZero item={item} />

                    {/* Reserved — opens stock modal */}
                    <StockCell value={item.totalReserved} item={item} />

                    {/* Available (In Stock - Reserved) — opens stock modal */}
                    <StockCell value={available} colorZero item={item} />

                    {/* Retail Price — new tab */}
                    <Table.Cell>
                      {item.productId && item.variantId ? (
                        <a
                          href={`/products/${item.productId}/variants/${item.variantId}/prices`}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="flex items-center w-full h-full font-medium text-ui-fg-base hover:text-ui-fg-interactive transition-colors whitespace-nowrap"
                        >
                          {formatPrice(item.price, item.currencyCode)}
                        </a>
                      ) : (
                        <span className="flex items-center w-full h-full text-ui-fg-muted whitespace-nowrap">
                          {formatPrice(item.price, item.currencyCode)}
                        </span>
                      )}
                    </Table.Cell>

                    {/* Dynamic price list columns — new tab, fallback to retail */}
                    {enableDynamicPricing &&
                      priceLists.map((pl) => {
                        const listPrice = item.pricesByList?.[pl.id];
                        const displayPrice = listPrice ?? item.price;
                        const isFallback = listPrice === undefined;
                        const editUrl = item.productId
                          ? `/price-lists/${pl.id}/products/edit?ids[]=${item.productId}`
                          : null;

                        const priceLabel = (
                          <span
                            className={clx(
                              "text-sm tabular-nums",
                              isFallback
                                ? "text-ui-fg-disabled italic"
                                : "text-ui-fg-subtle font-medium"
                            )}
                          >
                            ${displayPrice.toFixed(2)}
                          </span>
                        );

                        return (
                          <Table.Cell key={pl.id} className="whitespace-nowrap">
                            {editUrl ? (
                              <a
                                href={editUrl}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="flex items-center w-full h-full hover:text-ui-fg-interactive transition-colors"
                              >
                                {priceLabel}
                              </a>
                            ) : (
                              priceLabel
                            )}
                          </Table.Cell>
                        );
                      })}

                    {/* Actions */}
                    <Table.Cell>
                      <DropdownMenu>
                        <DropdownMenu.Trigger asChild>
                          <IconButton variant="transparent">
                            <EllipsisHorizontal />
                          </IconButton>
                        </DropdownMenu.Trigger>
                        <DropdownMenu.Content align="end">
                          <DropdownMenu.Item
                            onClick={() => goToInventoryItem(item.id)}
                          >
                            <PencilSquare className="mr-2" />
                            Edit Inventory
                          </DropdownMenu.Item>
                          {item.variantId && item.productId && (
                            <DropdownMenu.Item
                              onClick={() =>
                                goToVariantEdit(item.productId, item.variantId)
                              }
                            >
                              <PencilSquare className="mr-2" />
                              Edit Variant
                            </DropdownMenu.Item>
                          )}
                          <DropdownMenu.Separator />
                          <DropdownMenu.Item
                            className="text-ui-fg-error"
                            onClick={() => {}}
                          >
                            <Trash className="mr-2" />
                            Delete
                          </DropdownMenu.Item>
                        </DropdownMenu.Content>
                      </DropdownMenu>
                    </Table.Cell>
                  </Table.Row>
                );
              })
            )}
          </Table.Body>
        </Table>
      </div>

      {/* Stock details modal — opens on Reserved, In Stock, or Available click */}
      {selectedStockItem && (
        <InventoryStockModal
          open={!!selectedStockItem}
          onClose={() => setSelectedStockItem(null)}
          inventoryItemId={selectedStockItem.id}
          itemTitle={selectedStockItem.title}
          sku={selectedStockItem.sku}
        />
      )}
    </>
  );
};
