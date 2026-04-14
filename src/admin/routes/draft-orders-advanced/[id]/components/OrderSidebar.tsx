import { PencilSquare, ArrowUpRightOnBox } from "@medusajs/icons";
import {
  Container,
  Heading,
  Badge,
  Text,
  Label,
  Button,
  Select,
} from "@medusajs/ui";
import { useState } from "react";

import { fmtRel } from "../helpers";
import { ESTIMATE_STATUSES, STATUS_COLOR, TimelineEvent } from "../types";

interface Props {
  id: string;
  estimateRef: string | null;
  estimateTxnId: string | null;
  isSynced: boolean;
  estimateStatus: string | undefined;
  statusSaving: boolean;
  syncing: boolean;
  syncError: string | null;
  timeline: TimelineEvent[];
  orderCreatedAt: string;
  total: number;
  onStatusChange: (v: string) => void;
  onSync: () => void;
  onOpenModal: (modal: string) => void;
}

const ACTIVITY_INITIAL = 3;

export const OrderSidebar = ({
  id,
  estimateRef,
  estimateTxnId,
  isSynced,
  estimateStatus,
  statusSaving,
  syncing,
  syncError,
  timeline,
  orderCreatedAt,
  total,
  onStatusChange,
  onSync,
  onOpenModal,
}: Props) => {
  const isEmptyOrder = total <= 0;
  const badgeColor = estimateStatus
    ? ((STATUS_COLOR as Record<string, string>)[estimateStatus] ?? "grey")
    : "grey";
  const [activityExpanded, setActivityExpanded] = useState(false);

  return (
    <div className="w-[340px] shrink-0 flex flex-col gap-4">
      {/* Estimate Status */}
      <Container className="p-0 overflow-hidden">
        <div className="flex items-center justify-between px-6 py-4 border-b border-ui-border-base">
          <Heading level="h2">Estimate Status</Heading>
          {estimateStatus && (
            <Badge
              color={
                badgeColor as
                  | "grey"
                  | "blue"
                  | "purple"
                  | "orange"
                  | "green"
                  | "red"
              }
              size="small"
            >
              {estimateStatus}
            </Badge>
          )}
        </div>
        <div className="px-6 py-4">
          <Select
            value={estimateStatus}
            onValueChange={onStatusChange}
            disabled={statusSaving}
          >
            <Select.Trigger className="w-full">
              <Select.Value placeholder="Select a status..." />
            </Select.Trigger>
            <Select.Content>
              {ESTIMATE_STATUSES.map((st) => (
                <Select.Item key={st} value={st}>
                  {st}
                </Select.Item>
              ))}
            </Select.Content>
          </Select>
          {statusSaving && (
            <Text size="xsmall" className="text-ui-fg-muted mt-2">
              Saving...
            </Text>
          )}
        </div>
      </Container>

      {/* QuickBooks */}
      <Container className="p-0 overflow-hidden">
        <div className="flex items-center gap-2 px-6 py-4 border-b border-ui-border-base">
          <Heading level="h2">QuickBooks</Heading>
          <Badge color="blue" size="small">
            QB Desktop
          </Badge>
          {isSynced && (
            <Badge color="green" size="small">
              ✓ Synced
            </Badge>
          )}
        </div>
        <div className="px-6 py-4 space-y-4">
          <div>
            <Label className="mb-1 block text-sm text-ui-fg-subtle">
              Estimate Number
            </Label>
            <div className="font-mono text-sm px-3 py-2 rounded-md bg-ui-bg-subtle border border-ui-border-base text-ui-fg-muted min-h-[36px]">
              {estimateRef ?? (
                <span className="text-ui-fg-muted italic">Not synced yet</span>
              )}
            </div>
          </div>
          <div>
            <Label className="mb-1 block text-sm text-ui-fg-subtle">
              Estimate QB TxnID
            </Label>
            <div className="font-mono text-sm px-3 py-2 rounded-md bg-ui-bg-subtle border border-ui-border-base text-ui-fg-muted min-h-[36px]">
              {estimateTxnId ?? (
                <span className="text-ui-fg-muted italic">Not synced yet</span>
              )}
            </div>
          </div>
          {syncError && (
            <div className="p-3 rounded-md border border-ui-border-error">
              <Text size="small" className="text-ui-fg-error">
                ❌ {syncError}
              </Text>
            </div>
          )}
          <Button
            onClick={onSync}
            isLoading={syncing}
            disabled={syncing || (!isSynced && isEmptyOrder)}
            variant={isSynced ? "secondary" : "primary"}
            size="small"
            className="w-full"
          >
            {isSynced ? "Re-sync to QuickBooks" : "Save to QuickBooks"}
          </Button>
          <Text size="xsmall" className="text-ui-fg-muted">
            {!isSynced && isEmptyOrder
              ? "Order total must be > $0 to save to QuickBooks."
              : isSynced
                ? "Re-syncing updates the existing QB Estimate with current items, prices & shipping."
                : "Creates an Estimate in QB Desktop."}
          </Text>
        </div>
      </Container>

      {/* Activity */}
      <Container className="p-0 overflow-hidden">
        <div className="px-6 py-4 border-b border-ui-border-base">
          <Heading level="h2">Activity</Heading>
        </div>
        <div className="px-6 py-4 space-y-3">
          {timeline.length > 0 ? (
            (() => {
              const head = timeline.slice(0, ACTIVITY_INITIAL);
              const tail = timeline.slice(
                ACTIVITY_INITIAL,
                timeline.length - 1
              );
              const last = timeline[timeline.length - 1];
              const hasMore = tail.length > 0;

              const renderEvent = (e: TimelineEvent) => (
                <div key={e.id} className="flex items-start gap-3">
                  <div className="w-2 h-2 rounded-full bg-ui-fg-muted mt-1.5 shrink-0" />
                  <div className="flex-1 min-w-0">
                    <Text size="small" weight="plus" className="capitalize">
                      {e.title}
                    </Text>
                    {e.description && (
                      <Text size="xsmall" className="text-ui-fg-subtle">
                        {e.description}
                      </Text>
                    )}
                    {e.user && (
                      <Text size="xsmall" className="text-ui-fg-muted italic">
                        by {e.user}
                      </Text>
                    )}
                  </div>
                  <Text
                    size="xsmall"
                    className="text-ui-fg-muted whitespace-nowrap cursor-default"
                    title={new Date(e.created_at).toLocaleString("en-US", {
                      month: "short",
                      day: "numeric",
                      year: "numeric",
                      hour: "2-digit",
                      minute: "2-digit",
                      second: "2-digit",
                    })}
                  >
                    {fmtRel(e.created_at)}
                  </Text>
                </div>
              );

              return (
                <>
                  {head.map(renderEvent)}
                  {hasMore && (
                    <>
                      {activityExpanded && tail.map(renderEvent)}
                      <button
                        onClick={() => setActivityExpanded((v) => !v)}
                        className="text-ui-fg-muted hover:text-ui-fg-subtle text-xs py-0.5 transition-colors"
                      >
                        {activityExpanded
                          ? "Show less"
                          : `Show ${tail.length} more activit${tail.length === 1 ? "y" : "ies"}`}
                      </button>
                    </>
                  )}
                  {last &&
                    timeline.length > ACTIVITY_INITIAL &&
                    renderEvent(last)}
                </>
              );
            })()
          ) : (
            <div className="flex items-start gap-3">
              <div className="w-2 h-2 rounded-full bg-ui-fg-muted mt-1.5 shrink-0" />
              <div className="flex-1">
                <Text size="small" weight="plus">
                  Created
                </Text>
                <Text size="xsmall" className="text-ui-fg-subtle">
                  Draft order created
                </Text>
              </div>
              <Text
                size="xsmall"
                className="text-ui-fg-muted whitespace-nowrap cursor-default"
                title={new Date(orderCreatedAt).toLocaleString("en-US", {
                  month: "short",
                  day: "numeric",
                  year: "numeric",
                  hour: "2-digit",
                  minute: "2-digit",
                  second: "2-digit",
                })}
              >
                {fmtRel(orderCreatedAt)}
              </Text>
            </div>
          )}
        </div>
      </Container>

      {/* More */}
      <Container className="p-0 overflow-hidden">
        <div className="px-6 py-4 border-b border-ui-border-base">
          <Heading level="h2">More</Heading>
        </div>
        <div className="px-6 py-4 space-y-2">
          <button
            onClick={() => onOpenModal("metadata")}
            className="flex items-center justify-between w-full text-sm text-ui-fg-base hover:text-ui-fg-interactive py-1"
          >
            <span>Metadata</span>
            <PencilSquare className="text-ui-fg-muted" />
          </button>
          <button
            onClick={() => window.open(`/app/draft-orders/${id}`, "_blank")}
            className="flex items-center justify-between w-full text-sm text-ui-fg-base hover:text-ui-fg-interactive py-1"
          >
            <span>Full native editor</span>
            <ArrowUpRightOnBox className="text-ui-fg-muted" />
          </button>
        </div>
      </Container>
    </div>
  );
};
