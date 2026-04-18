import {
  Container,
  Heading,
  Text,
  Label,
  Select,
  Button,
  Switch,
} from "@medusajs/ui";

type StoreHoursSectionProps = {
  storeOpenHour: string;
  setStoreOpenHour: (v: string) => void;
  storeCloseHour: string;
  setStoreCloseHour: (v: string) => void;
  storeSatOpen: boolean;
  setStoreSatOpen: (v: boolean) => void;
  storeSatOpenHour: string;
  setStoreSatOpenHour: (v: string) => void;
  storeSatCloseHour: string;
  setStoreSatCloseHour: (v: string) => void;
  storeSunOpen: boolean;
  setStoreSunOpen: (v: boolean) => void;
  storeSunOpenHour: string;
  setStoreSunOpenHour: (v: string) => void;
  storeSunCloseHour: string;
  setStoreSunCloseHour: (v: string) => void;
  storeTimezone: string;
  setStoreTimezone: (v: string) => void;
  onSave: () => void;
};

const HOURS = Array.from({ length: 24 }, (_, i) => ({
  value: String(i),
  label: String(i).padStart(2, "0") + ":00",
}));

const TIMEZONES = [
  { value: "America/New_York", label: "Eastern (ET)" },
  { value: "America/Chicago", label: "Central (CT)" },
  { value: "America/Denver", label: "Mountain (MT)" },
  { value: "America/Los_Angeles", label: "Pacific (PT)" },
  { value: "America/Puerto_Rico", label: "Puerto Rico (AT)" },
  { value: "UTC", label: "UTC" },
];

const HourSelect = ({
  id,
  value,
  onChange,
}: {
  id: string;
  value: string;
  onChange: (v: string) => void;
}) => (
  <Select value={value} onValueChange={onChange}>
    <Select.Trigger id={id}>
      <Select.Value />
    </Select.Trigger>
    <Select.Content>
      {HOURS.map((h) => (
        <Select.Item key={h.value} value={h.value}>
          {h.label}
        </Select.Item>
      ))}
    </Select.Content>
  </Select>
);

export const StoreHoursSection = ({
  storeOpenHour,
  setStoreOpenHour,
  storeCloseHour,
  setStoreCloseHour,
  storeSatOpen,
  setStoreSatOpen,
  storeSatOpenHour,
  setStoreSatOpenHour,
  storeSatCloseHour,
  setStoreSatCloseHour,
  storeSunOpen,
  setStoreSunOpen,
  storeSunOpenHour,
  setStoreSunOpenHour,
  storeSunCloseHour,
  setStoreSunCloseHour,
  storeTimezone,
  setStoreTimezone,
  onSave,
}: StoreHoursSectionProps) => {
  return (
    <Container>
      <div className="p-4 space-y-4">
        <div>
          <Heading level="h3" className="text-sm font-medium">
            🕐 Store Hours
          </Heading>
          <Text className="text-xs text-ui-fg-subtle mt-0.5">
            Define when the physical store is open. Syncs that respect these
            hours will pause outside this window.
          </Text>
        </div>

        {/* Timezone */}
        <div className="max-w-xs">
          <Label htmlFor="store-tz" className="mb-1 block text-xs">
            Timezone
          </Label>
          <Select value={storeTimezone} onValueChange={setStoreTimezone}>
            <Select.Trigger id="store-tz">
              <Select.Value />
            </Select.Trigger>
            <Select.Content>
              {TIMEZONES.map((tz) => (
                <Select.Item key={tz.value} value={tz.value}>
                  {tz.label}
                </Select.Item>
              ))}
            </Select.Content>
          </Select>
        </div>

        {/* Hours rows */}
        <div className="space-y-0">
          {/* Monday – Friday */}
          <div className="grid grid-cols-[130px_1fr_1fr] gap-3 items-end py-3 border-b border-ui-border-base">
            <div className="pb-1">
              <Text className="text-xs font-semibold">Monday – Friday</Text>
              <Text className="text-xs text-ui-fg-subtle">Always open</Text>
            </div>
            <div>
              <Label htmlFor="mf-open" className="mb-1 block text-xs">
                Opens
              </Label>
              <HourSelect
                id="mf-open"
                value={storeOpenHour}
                onChange={setStoreOpenHour}
              />
            </div>
            <div>
              <Label htmlFor="mf-close" className="mb-1 block text-xs">
                Closes
              </Label>
              <HourSelect
                id="mf-close"
                value={storeCloseHour}
                onChange={setStoreCloseHour}
              />
            </div>
          </div>

          {/* Saturday */}
          <div className="grid grid-cols-[130px_1fr_1fr] gap-3 items-end py-3 border-b border-ui-border-base">
            <div className="flex flex-col gap-1">
              <div className="flex items-center gap-2">
                <Switch
                  id="sat-toggle"
                  checked={storeSatOpen}
                  onCheckedChange={setStoreSatOpen}
                />
                <Label
                  htmlFor="sat-toggle"
                  className="text-xs font-semibold cursor-pointer"
                >
                  Saturday
                </Label>
              </div>
              <Text className="text-xs text-ui-fg-subtle pl-8">
                {storeSatOpen ? "Open" : "Closed"}
              </Text>
            </div>
            {storeSatOpen ? (
              <>
                <div>
                  <Label htmlFor="sat-open" className="mb-1 block text-xs">
                    Opens
                  </Label>
                  <HourSelect
                    id="sat-open"
                    value={storeSatOpenHour}
                    onChange={setStoreSatOpenHour}
                  />
                </div>
                <div>
                  <Label htmlFor="sat-close" className="mb-1 block text-xs">
                    Closes
                  </Label>
                  <HourSelect
                    id="sat-close"
                    value={storeSatCloseHour}
                    onChange={setStoreSatCloseHour}
                  />
                </div>
              </>
            ) : (
              <Text className="text-xs text-ui-fg-muted col-span-2 self-center">
                —
              </Text>
            )}
          </div>

          {/* Sunday */}
          <div className="grid grid-cols-[130px_1fr_1fr] gap-3 items-end py-3">
            <div className="flex flex-col gap-1">
              <div className="flex items-center gap-2">
                <Switch
                  id="sun-toggle"
                  checked={storeSunOpen}
                  onCheckedChange={setStoreSunOpen}
                />
                <Label
                  htmlFor="sun-toggle"
                  className="text-xs font-semibold cursor-pointer"
                >
                  Sunday
                </Label>
              </div>
              <Text className="text-xs text-ui-fg-subtle pl-8">
                {storeSunOpen ? "Open" : "Closed"}
              </Text>
            </div>
            {storeSunOpen ? (
              <>
                <div>
                  <Label htmlFor="sun-open" className="mb-1 block text-xs">
                    Opens
                  </Label>
                  <HourSelect
                    id="sun-open"
                    value={storeSunOpenHour}
                    onChange={setStoreSunOpenHour}
                  />
                </div>
                <div>
                  <Label htmlFor="sun-close" className="mb-1 block text-xs">
                    Closes
                  </Label>
                  <HourSelect
                    id="sun-close"
                    value={storeSunCloseHour}
                    onChange={setStoreSunCloseHour}
                  />
                </div>
              </>
            ) : (
              <Text className="text-xs text-ui-fg-muted col-span-2 self-center">
                —
              </Text>
            )}
          </div>
        </div>

        <div className="pt-2 border-t border-ui-border-base flex justify-end">
          <Button size="small" onClick={onSave}>
            Save Store Hours
          </Button>
        </div>
      </div>
    </Container>
  );
};
