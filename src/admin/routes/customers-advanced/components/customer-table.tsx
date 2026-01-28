import { Table, StatusBadge, Badge } from "@medusajs/ui";
import { Link } from "react-router-dom";
import type { MeiliCustomer } from "../../../lib/meili-types";

interface CustomerTableProps {
    isLoading: boolean;
    isError: boolean;
    error: any;
    data: {
        hits: MeiliCustomer[];
    } | undefined;
}

export const CustomerTable = ({
    isLoading,
    isError,
    error,
    data
}: CustomerTableProps) => {
    if (isError) {
        return (
            <div className="flex h-[400px] w-full items-center justify-center text-ui-fg-subtle">
                <div className="text-center">
                    <p className="font-medium text-ui-fg-error">Error loading customers</p>
                    <p className="text-small">{error?.message}</p>
                </div>
            </div>
        );
    }

    if (isLoading && (!data || data.hits.length === 0)) {
        return (
            <div className="flex h-[400px] w-full items-center justify-center text-ui-fg-subtle">
                <div className="animate-pulse flex flex-col items-center gap-y-2">
                    <div className="h-8 w-8 rounded-full bg-ui-bg-subtle-pressed" />
                    <p className="text-small">Syncing customers...</p>
                </div>
            </div>
        );
    }

    if (!data || data.hits.length === 0) {
        return (
            <div className="flex h-[400px] w-full items-center justify-center text-ui-fg-subtle">
                <p>No customers found.</p>
            </div>
        );
    }

    return (
        <div className="flex-1 overflow-auto">
            <Table>
                <Table.Header className="border-t-0">
                    <Table.Row>
                        <Table.HeaderCell>Company / Name</Table.HeaderCell>
                        <Table.HeaderCell>Email</Table.HeaderCell>
                        <Table.HeaderCell>Phone</Table.HeaderCell>
                        <Table.HeaderCell>Customer Types</Table.HeaderCell>
                        <Table.HeaderCell>Price Level</Table.HeaderCell>
                        <Table.HeaderCell>List ID</Table.HeaderCell>
                        <Table.HeaderCell>Status</Table.HeaderCell>
                    </Table.Row>
                </Table.Header>
                <Table.Body>
                    {data.hits.map((customer) => (
                        <Table.Row
                            key={customer.id}
                            className="hover:bg-ui-bg-subtle-hover transition-colors group cursor-pointer"
                        >
                            <Table.Cell>
                                <Link
                                    to={`/customers/${customer.id}`}
                                    className="flex items-center w-full h-full font-medium text-ui-fg-base hover:text-ui-fg-interactive transition-colors"
                                >
                                    <div className="flex flex-col">
                                        <span>{customer.company_name}</span>
                                        <span className="text-xs text-ui-fg-subtle">
                                            {customer.first_name} {customer.last_name}
                                        </span>
                                    </div>
                                </Link>
                            </Table.Cell>

                            <Table.Cell>
                                <Link
                                    to={`/customers/${customer.id}`}
                                    className="flex items-center w-full h-full text-ui-fg-subtle"
                                >
                                    {customer.email}
                                </Link>
                            </Table.Cell>

                            <Table.Cell>
                                <Link
                                    to={`/customers/${customer.id}`}
                                    className="flex items-center w-full h-full text-ui-fg-subtle"
                                >
                                    {customer.phone || "-"}
                                </Link>
                            </Table.Cell>

                            <Table.Cell>
                                <Link
                                    to={`/customers/${customer.id}`}
                                    className="flex items-center w-full h-full"
                                >
                                    <Badge size="small" color={customer.customer_type === 'Wholesale' ? 'blue' : 'grey'}>
                                        {customer.customer_type}
                                    </Badge>
                                </Link>
                            </Table.Cell>

                            <Table.Cell>
                                <Link
                                    to={`/customers/${customer.id}`}
                                    className="flex items-center w-full h-full"
                                >
                                    <Badge size="small" color={customer.price_level === 'Wholesale' ? 'green' : 'grey'}>
                                        {customer.price_level}
                                    </Badge>
                                </Link>
                            </Table.Cell>

                            <Table.Cell>
                                <Link
                                    to={`/customers/${customer.id}`}
                                    className="flex items-center w-full h-full font-mono text-xs text-ui-fg-subtle"
                                >
                                    {customer.list_id}
                                </Link>
                            </Table.Cell>

                            <Table.Cell>
                                <Link
                                    to={`/customers/${customer.id}`}
                                    className="flex items-center w-full h-full"
                                >
                                    <StatusBadge color={customer.has_account ? "green" : "orange"} className="text-xs">
                                        {customer.has_account ? "Registered" : "Guest"}
                                    </StatusBadge>
                                </Link>
                            </Table.Cell>
                        </Table.Row>
                    ))}
                </Table.Body>
            </Table>
        </div>
    );
};
