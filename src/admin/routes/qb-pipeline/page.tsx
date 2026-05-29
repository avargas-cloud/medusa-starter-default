import { defineRouteConfig } from "@medusajs/admin-sdk";
import { Bolt } from "@medusajs/icons";
import { Heading, Tabs, Text } from "@medusajs/ui";
import { useCallback, useRef, useState } from "react";

import { BridgeStatus } from "../qb-sync/components/BridgeStatus";
import { PipelineTable } from "../qb-sync/components/PipelineTable";

import { CustomerSyncPipelineSection } from "./components/CustomerSyncPipelineSection";
import { InventoryAdjustmentPipelineSection } from "./components/InventoryAdjustmentPipelineSection";
import { ItemPipelineSection } from "./components/ItemPipelineSection";
import { PipelinesBreakdown } from "./components/PipelinesBreakdown";
import { PurchaseOrderPipelineSection } from "./components/PurchaseOrderPipelineSection";
import { VendorPipelineSection } from "./components/VendorPipelineSection";
import { WaitingOrdersSection } from "./components/WaitingOrdersSection";

/**
 * Walks up from `el` to find the nearest scrollable ancestor so we can
 * preserve its scroll position across tab switches. Falls back to `window`.
 */
const findScrollParent = (el: HTMLElement | null): HTMLElement | Window => {
  let node = el?.parentElement ?? null;
  while (node) {
    const { overflowY } = getComputedStyle(node);
    if (
      (overflowY === "auto" || overflowY === "scroll") &&
      node.scrollHeight > node.clientHeight
    ) {
      return node;
    }
    node = node.parentElement;
  }
  return window;
};

const QbPipelinePage = () => {
  const containerRef = useRef<HTMLDivElement>(null);
  const [activeTab, setActiveTab] = useState("operations");

  // Switching tabs would otherwise jump the screen: Radix focuses the new
  // trigger (browser scrolls it into view) and the new content's differing
  // height clamps the scroll position. Capture and restore the scroll offset
  // so the viewport stays put.
  const handleTabChange = useCallback((next: string) => {
    const scroller = findScrollParent(containerRef.current);
    const top = scroller instanceof Window ? window.scrollY : scroller.scrollTop;
    setActiveTab(next);
    requestAnimationFrame(() => {
      if (scroller instanceof Window) {
        window.scrollTo({ top });
      } else {
        scroller.scrollTop = top;
      }
    });
  }, []);

  return (
    <div ref={containerRef} className="flex flex-col gap-4 p-6">
      <div>
        <Heading level="h1">QuickBooks Pipelines</Heading>
        <Text className="text-ui-fg-subtle mt-1">
          Real-time queues for item creation and order document sync with
          QuickBooks Desktop. Errored items can be retried; failed ops can be
          flushed from the Sales Pipeline tab.
        </Text>
      </div>

      <BridgeStatus />

      <PipelinesBreakdown />

      <Tabs value={activeTab} onValueChange={handleTabChange}>
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
