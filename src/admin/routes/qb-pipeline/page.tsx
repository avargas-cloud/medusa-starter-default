import { defineRouteConfig } from "@medusajs/admin-sdk";
import { Bolt } from "@medusajs/icons";
import { Heading, Tabs, Text } from "@medusajs/ui";

import { BridgeStatus } from "../qb-sync/components/BridgeStatus";
import { PipelineTable } from "../qb-sync/components/PipelineTable";
import { CustomerSyncPipelineSection } from "./components/CustomerSyncPipelineSection";
import { InventoryAdjustmentPipelineSection } from "./components/InventoryAdjustmentPipelineSection";
import { ItemPipelineSection } from "./components/ItemPipelineSection";
import { PurchaseOrderPipelineSection } from "./components/PurchaseOrderPipelineSection";
import { VendorPipelineSection } from "./components/VendorPipelineSection";
import { WaitingOrdersSection } from "./components/WaitingOrdersSection";

const QbPipelinePage = () => {
  return (
    <div className="flex flex-col gap-4 p-6">
      <div>
        <Heading level="h1">QuickBooks Pipelines</Heading>
        <Text className="text-ui-fg-subtle mt-1">
          Real-time queues for item creation and order document sync with
          QuickBooks Desktop. Errored items can be retried; failed ops can be
          flushed from the Sales Pipeline tab.
        </Text>
      </div>

      <BridgeStatus />

      <Tabs defaultValue="operations">
        <Tabs.List className="gap-1">
          <Tabs.Trigger
            value="operations"
            className="px-4 py-2 font-semibold data-[state=active]:bg-ui-bg-base-pressed data-[state=active]:text-ui-fg-base data-[state=active]:border-b-2 data-[state=active]:border-ui-fg-interactive"
          >
            Sales Pipeline
          </Tabs.Trigger>
          <Tabs.Trigger
            value="items"
            className="px-4 py-2 font-semibold data-[state=active]:bg-ui-bg-base-pressed data-[state=active]:text-ui-fg-base data-[state=active]:border-b-2 data-[state=active]:border-ui-fg-interactive"
          >
            Item Pipeline
          </Tabs.Trigger>
          <Tabs.Trigger
            value="inventory-adjustments"
            className="px-4 py-2 font-semibold data-[state=active]:bg-ui-bg-base-pressed data-[state=active]:text-ui-fg-base data-[state=active]:border-b-2 data-[state=active]:border-ui-fg-interactive"
          >
            Inventory Adjustments
          </Tabs.Trigger>
          <Tabs.Trigger
            value="po-pipeline"
            className="px-4 py-2 font-semibold data-[state=active]:bg-ui-bg-base-pressed data-[state=active]:text-ui-fg-base data-[state=active]:border-b-2 data-[state=active]:border-ui-fg-interactive"
          >
            Purchase Pipeline
          </Tabs.Trigger>
          <Tabs.Trigger
            value="vendors"
            className="px-4 py-2 font-semibold data-[state=active]:bg-ui-bg-base-pressed data-[state=active]:text-ui-fg-base data-[state=active]:border-b-2 data-[state=active]:border-ui-fg-interactive"
          >
            Vendors
          </Tabs.Trigger>
          <Tabs.Trigger
            value="waiting-orders"
            className="px-4 py-2 font-semibold data-[state=active]:bg-ui-bg-base-pressed data-[state=active]:text-ui-fg-base data-[state=active]:border-b-2 data-[state=active]:border-ui-fg-interactive"
          >
            Waiting Orders
          </Tabs.Trigger>
          <Tabs.Trigger
            value="customer-sync"
            className="px-4 py-2 font-semibold data-[state=active]:bg-ui-bg-base-pressed data-[state=active]:text-ui-fg-base data-[state=active]:border-b-2 data-[state=active]:border-ui-fg-interactive"
          >
            Customer Sync
          </Tabs.Trigger>
        </Tabs.List>
        <Tabs.Content value="operations" className="pt-4">
          <PipelineTable />
        </Tabs.Content>
        <Tabs.Content value="items" className="pt-4">
          <ItemPipelineSection />
        </Tabs.Content>
        <Tabs.Content value="inventory-adjustments" className="pt-4">
          <InventoryAdjustmentPipelineSection />
        </Tabs.Content>
        <Tabs.Content value="po-pipeline" className="pt-4">
          <PurchaseOrderPipelineSection />
        </Tabs.Content>
        <Tabs.Content value="vendors" className="pt-4">
          <VendorPipelineSection />
        </Tabs.Content>
        <Tabs.Content value="waiting-orders" className="pt-4">
          <WaitingOrdersSection />
        </Tabs.Content>
        <Tabs.Content value="customer-sync" className="pt-4">
          <CustomerSyncPipelineSection />
        </Tabs.Content>
      </Tabs>
    </div>
  );
};

export const config = defineRouteConfig({
  label: "QB Pipeline",
  icon: Bolt,
});

export default QbPipelinePage;
