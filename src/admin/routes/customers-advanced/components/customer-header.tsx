import { Input, Select, Heading } from "@medusajs/ui";
import { useQueryClient } from "@tanstack/react-query";
import {
    MagnifyingGlass,
} from "@medusajs/icons";
import { SyncStatusButton } from "../../../components/shared/sync-status-button";

interface CustomerHeaderProps {
    searchQuery: string;
    setSearchQuery: (query: string) => void;
    customerTypeFilter: string;
    setCustomerTypeFilter: (filter: string) => void;
    priceLevelFilter: string;
    setPriceLevelFilter: (filter: string) => void;
    sortBy: string;
    setSortBy: (sort: string) => void;
    totalHits: number;
    isSyncing: boolean;
}

export const CustomerHeader = ({
    searchQuery,
    setSearchQuery,
    customerTypeFilter,
    setCustomerTypeFilter,
    priceLevelFilter,
    setPriceLevelFilter,
    sortBy,
    setSortBy,
    totalHits,
    isSyncing
}: CustomerHeaderProps) => {
    const queryClient = useQueryClient()
    return (
        <>
            {/* Header Title & Sync Status */}
            <div className="flex items-center justify-between px-6 py-4 border-b">
                <div>
                    <div className="flex items-center gap-4">
                        <Heading level="h1" className="text-ui-fg-base">
                            Customers
                        </Heading>
                        <SyncStatusButton
                            entity="customers"
                            onSyncComplete={() => queryClient.invalidateQueries({ queryKey: ["meili-customers"] })}
                        />
                    </div>
                    <div className="flex items-center gap-x-2 mt-1">
                        <span className="text-ui-fg-subtle text-small">
                            {totalHits} results
                        </span>
                        {isSyncing && (
                            <div className="flex items-center gap-x-2 text-ui-fg-interactive animate-pulse ml-2">
                                <div className="w-2 h-2 rounded-full bg-ui-bg-interactive" />
                                <span className="text-small font-medium">Syncing...</span>
                            </div>
                        )}
                    </div>
                </div>
            </div>

            {/* Toolbar */}
            <div className="px-6 py-4 border-b bg-ui-bg-subtle">
                <div className="flex items-center gap-3">
                    {/* Search */}
                    <div className="flex-1 max-w-md relative">
                        <Input
                            placeholder="Search by name, email, company, list ID..."
                            value={searchQuery}
                            onChange={(e) => setSearchQuery(e.target.value)}
                            className="w-full"
                            autoFocus
                        />
                        <div className="absolute right-3 top-1/2 -translate-y-1/2 text-ui-fg-muted">
                            <MagnifyingGlass />
                        </div>
                    </div>

                    <div className="flex items-center gap-x-2">
                        {/* Customer Type Filter */}
                        <Select onValueChange={setCustomerTypeFilter} value={customerTypeFilter}>
                            <Select.Trigger className="w-[240px]">
                                <Select.Value placeholder="Customer Types" />
                            </Select.Trigger>
                            <Select.Content className="max-h-[300px]">
                                <Select.Item value="all">All Customer Types</Select.Item>
                                <Select.Item value="Home Owner / Renter">Home Owner / Renter</Select.Item>
                                <Select.Item value="Commercial Business">Commercial Business</Select.Item>
                                <Select.Item value="General Contractor">General Contractor</Select.Item>
                                <Select.Item value="Electrical Contractor">Electrical Contractor</Select.Item>
                                <Select.Item value="Independent Contractor">Independent Contractor</Select.Item>
                                <Select.Item value="Carpenter / General Assembler">Carpenter / General Assembler</Select.Item>
                                <Select.Item value="Designer, Architect">Designer, Architect</Select.Item>
                                <Select.Item value="Standard">Standard</Select.Item>
                                <Select.Item value="Real State Agent / Company">Real Estate Agent</Select.Item>
                                <Select.Item value="Developer">Developer</Select.Item>
                                <Select.Item value="Electrician">Electrician</Select.Item>
                                <Select.Item value="Distributor">Distributor</Select.Item>
                                <Select.Item value="Hospitality">Hospitality</Select.Item>
                                <Select.Item value="Signs Manufacturer">Signs Manufacturer</Select.Item>
                                <Select.Item value="Condo Association">Condo Association</Select.Item>
                                <Select.Item value="Show Biz Company/Contractor">Show Biz / Events</Select.Item>
                                <Select.Item value="Online Customer">Online Customer</Select.Item>
                            </Select.Content>
                        </Select>

                        {/* Price Level Filter */}
                        <Select onValueChange={setPriceLevelFilter} value={priceLevelFilter}>
                            <Select.Trigger className="w-[200px]">
                                <Select.Value placeholder="Price Level" />
                            </Select.Trigger>
                            <Select.Content className="max-h-[300px]">
                                <Select.Item value="all">Price Levels</Select.Item>
                                <Select.Item value="Retail">Retail</Select.Item>
                                <Select.Item value="Wholesale">Wholesale</Select.Item>
                            </Select.Content>
                        </Select>

                        {/* Sorting */}
                        <Select onValueChange={setSortBy} value={sortBy}>
                            <Select.Trigger className="w-[200px]">
                                <Select.Value placeholder="Sort by" />
                            </Select.Trigger>
                            <Select.Content className="max-h-[300px]">
                                <Select.Item value="company_name:asc">Company (A-Z)</Select.Item>
                                <Select.Item value="company_name:desc">Company (Z-A)</Select.Item>
                                <Select.Item value="created_at:desc">Newest</Select.Item>
                                <Select.Item value="created_at:asc">Oldest</Select.Item>
                            </Select.Content>
                        </Select>
                    </div>
                </div>
            </div>
        </>
    );
};
