import { Table, Text, Badge } from "@medusajs/ui";
import { TagSolid } from "@medusajs/icons";
import type { MeiliProduct } from "../../../lib/meili-types";

interface ProductTableProps {
    isLoading: boolean;
    isError: boolean;
    error: any;
    data: any;
    searchQuery: string;
    handleRowClick: (product: MeiliProduct) => void;
}

export const ProductTable = ({
    isLoading,
    isError,
    error,
    data,
    searchQuery,
    handleRowClick
}: ProductTableProps) => {
    return (
        <div className="flex-1 overflow-auto">
            {isError && (
                <div className="p-6 text-center">
                    <Text className="text-ui-fg-error">
                        Error loading products: {error instanceof Error ? error.message : "Unknown error"}
                    </Text>
                </div>
            )}

            {!isError && (
                <Table>
                    <Table.Header>
                        <Table.Row>
                            <Table.HeaderCell className="w-16">Image</Table.HeaderCell>
                            <Table.HeaderCell>Title</Table.HeaderCell>
                            <Table.HeaderCell>Handle</Table.HeaderCell>
                            <Table.HeaderCell>SKUs</Table.HeaderCell>
                            <Table.HeaderCell className="w-32">Material</Table.HeaderCell>
                            <Table.HeaderCell className="w-32">Status</Table.HeaderCell>
                        </Table.Row>
                    </Table.Header>

                    <Table.Body>
                        {isLoading ? (
                            <Table.Row>
                                <Table.Cell className="text-center py-8">
                                    <Text className="text-ui-fg-subtle">Loading products...</Text>
                                </Table.Cell>
                            </Table.Row>
                        ) : data?.hits.length === 0 ? (
                            <Table.Row>
                                <Table.Cell className="text-center py-8">
                                    <Text className="text-ui-fg-subtle">
                                        {searchQuery ? "No products found" : "Type to search products"}
                                    </Text>
                                </Table.Cell>
                            </Table.Row>
                        ) : (
                            data?.hits.map((product: MeiliProduct) => (
                                <Table.Row
                                    key={product.id}
                                    onClick={() => handleRowClick(product)}
                                    className="cursor-pointer hover:bg-ui-bg-subtle-hover transition-colors"
                                >
                                    {/* Thumbnail */}
                                    <Table.Cell>
                                        <div className="h-10 w-10 rounded-md overflow-hidden bg-ui-bg-subtle flex items-center justify-center">
                                            {product.thumbnail ? (
                                                <img
                                                    src={product.thumbnail}
                                                    alt={product.title}
                                                    className="h-full w-full object-cover"
                                                />
                                            ) : (
                                                <TagSolid className="text-ui-fg-muted" />
                                            )}
                                        </div>
                                    </Table.Cell>

                                    {/* Title */}
                                    <Table.Cell>
                                        <Text weight="plus" className="text-ui-fg-base">
                                            {product.title}
                                        </Text>
                                    </Table.Cell>

                                    {/* Handle */}
                                    <Table.Cell>
                                        <Text size="small" className="text-ui-fg-subtle font-mono">
                                            {product.handle}
                                        </Text>
                                    </Table.Cell>

                                    {/* Variant SKUs */}
                                    <Table.Cell>
                                        <div className="flex gap-1 flex-wrap max-w-[250px]">
                                            {product.variant_sku?.slice(0, 3).map((sku: string, idx: number) => (
                                                <Badge key={idx} size="small" className="font-mono">
                                                    {sku}
                                                </Badge>
                                            ))}
                                            {product.variant_sku?.length > 3 && (
                                                <Badge size="small" className="bg-ui-bg-subtle">
                                                    +{product.variant_sku.length - 3}
                                                </Badge>
                                            )}
                                        </div>
                                    </Table.Cell>

                                    {/* Material */}
                                    <Table.Cell>
                                        {product.metadata_material && (
                                            <Badge size="small">
                                                {product.metadata_material}
                                            </Badge>
                                        )}
                                    </Table.Cell>

                                    {/* Status */}
                                    <Table.Cell>
                                        <Badge
                                            size="small"
                                            color={product.status === "published" ? "green" : "grey"}
                                            className="capitalize"
                                        >
                                            {product.status}
                                        </Badge>
                                    </Table.Cell>
                                </Table.Row>
                            ))
                        )}
                    </Table.Body>
                </Table>
            )}
        </div>
    );
};
