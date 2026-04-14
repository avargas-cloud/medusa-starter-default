import {
  Container,
  Heading,
  Text,
  Label,
  Select,
  Button,
  Switch,
} from "@medusajs/ui";
import { type ReactNode } from "react";

type SyncInterval = { value: string; label: string };

type SyncCardProps = {
  title: string;
  intervalValue: string;
  onIntervalChange: (v: string) => void;
  intervals: SyncInterval[];
  respectHours: boolean;
  onRespectHoursChange: (v: boolean) => void;
  onSave: () => void;
  onViewReport: () => void;
  onSyncNow: () => void;
  isSyncing: boolean;
  lastSync: string | null;
  formatSyncDate: (d: string | null) => string;
  // Optional: time-of-day picker (for price/customer 24h intervals)
  showTimePicker?: boolean;
  timeValue?: string;
  onTimeChange?: (v: string) => void;
  timeOptions?: SyncInterval[];
  // Optional: extra action rows (e.g. reconcile for customers)
  footer?: ReactNode;
};

export const SyncCard = ({
  title,
  intervalValue,
  onIntervalChange,
  intervals,
  respectHours,
  onRespectHoursChange,
  onSave,
  onViewReport,
  onSyncNow,
  isSyncing,
  lastSync,
  formatSyncDate,
  showTimePicker,
  timeValue,
  onTimeChange,
  timeOptions,
  footer,
}: SyncCardProps) => {
  return (
    <Container>
      <div className="p-4 space-y-3">
        <Heading level="h3" className="text-sm font-medium">
          {title}
        </Heading>

        <div className="space-y-3">
          {/* Interval selector */}
          <div>
            <Label htmlFor={`${title}-interval`} className="mb-1 block text-xs">
              Interval
            </Label>
            <Select value={intervalValue} onValueChange={onIntervalChange}>
              <Select.Trigger id={`${title}-interval`}>
                <Select.Value />
              </Select.Trigger>
              <Select.Content>
                {intervals.map((interval) => (
                  <Select.Item key={interval.value} value={interval.value}>
                    {interval.label}
                  </Select.Item>
                ))}
              </Select.Content>
            </Select>
          </div>

          {/* Optional time-of-day picker */}
          {showTimePicker &&
            intervalValue === "24" &&
            timeOptions &&
            onTimeChange && (
              <div>
                <Label htmlFor={`${title}-time`} className="mb-1 block text-xs">
                  Time of Day
                </Label>
                <Select value={timeValue} onValueChange={onTimeChange}>
                  <Select.Trigger id={`${title}-time`}>
                    <Select.Value />
                  </Select.Trigger>
                  <Select.Content>
                    {timeOptions.map((t) => (
                      <Select.Item key={t.value} value={t.value}>
                        {t.label}
                      </Select.Item>
                    ))}
                  </Select.Content>
                </Select>
              </div>
            )}

          {/* Respect store hours toggle */}
          <div className="flex items-center justify-between p-2 rounded-lg bg-ui-bg-subtle">
            <div>
              <Text className="text-xs font-medium">
                🕐 Respect Store Hours
              </Text>
              <Text className="text-xs text-ui-fg-subtle">
                Skip syncs outside the store hours window
              </Text>
            </div>
            <Switch
              id={`${title}-respect`}
              checked={respectHours}
              onCheckedChange={onRespectHoursChange}
              disabled={intervalValue === "disabled"}
            />
          </div>

          {/* Action buttons */}
          <div className="flex gap-2">
            <Button variant="secondary" onClick={onSave} className="flex-1">
              Save
            </Button>
            <Button
              variant="secondary"
              onClick={onViewReport}
              className="flex-1"
            >
              View Report
            </Button>
            <Button
              onClick={onSyncNow}
              isLoading={isSyncing}
              disabled={isSyncing}
              className="flex-1"
            >
              {isSyncing ? "Syncing..." : "Sync Now"}
            </Button>
          </div>

          {/* Optional footer (e.g. reconcile buttons) */}
          {footer && (
            <div className="border-t border-ui-border-base pt-3">{footer}</div>
          )}

          {/* Last sync timestamp */}
          <div className="flex items-center gap-1.5 text-xs text-ui-fg-subtle pt-1 border-t border-ui-border-base">
            {lastSync ? (
              <>
                <span className="text-green-600">✅</span>
                <span>
                  Last sync:{" "}
                  <span className="font-medium text-ui-fg-base">
                    {formatSyncDate(lastSync)}
                  </span>
                </span>
              </>
            ) : (
              <span className="text-ui-fg-muted">No sync recorded yet</span>
            )}
          </div>
        </div>
      </div>
    </Container>
  );
};
