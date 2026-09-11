import { Badge, Switch, Text } from "@medusajs/ui";
import { Link } from "react-router-dom";

import type { MeiliProduct } from "../../../lib/meili-types";

interface StatusCellProps {
  product: MeiliProduct;
  status: MeiliProduct["status"];
  publishingMode: boolean;
  pending: boolean;
  onToggle: (product: MeiliProduct) => void;
}

/**
 * Status column. Read mode links to the product like every other cell;
 * publishing mode swaps the badge for a switch so one click flips
 * draft ↔ published without opening the product page.
 */
export const StatusCell = ({
  product,
  status,
  publishingMode,
  pending,
  onToggle,
}: StatusCellProps) => {
  const isPublished = status === "published";

  if (!publishingMode) {
    return (
      <Link
        to={`/products/${product.id}`}
        className="flex items-center w-full h-full hover:text-ui-fg-interactive transition-colors"
      >
        <Badge
          size="small"
          color={isPublished ? "green" : "grey"}
          className="capitalize"
        >
          {status}
        </Badge>
      </Link>
    );
  }

  return (
    <label
      className="flex items-center gap-2 cursor-pointer select-none"
      data-testid={`status-toggle-${product.id}`}
      data-status={status}
    >
      <Switch
        size="small"
        checked={isPublished}
        disabled={pending}
        onCheckedChange={() => onToggle(product)}
        aria-label={`${isPublished ? "Unpublish" : "Publish"} ${product.title}`}
      />
      <Text
        size="xsmall"
        className={
          isPublished
            ? "text-ui-tag-green-text capitalize"
            : "text-ui-fg-muted capitalize"
        }
      >
        {pending ? "Saving…" : status}
      </Text>
    </label>
  );
};
