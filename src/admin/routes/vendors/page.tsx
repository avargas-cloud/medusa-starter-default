import { defineRouteConfig } from "@medusajs/admin-sdk";
import { BuildingTax, ArrowPath } from "@medusajs/icons";
import {
  Badge,
  Button,
  Container,
  Heading,
  Input,
  Table,
  Text,
  toast,
} from "@medusajs/ui";
import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";

type SyncRun = {
  id: string;
  status: "queued" | "fetching" | "processing" | "completed" | "failed" | "cancelled";
  total_count: number;
  processed_count: number;
  created_count: number;
  updated_count: number;
  error_count: number;
  started_at: string | null;
  completed_at: string | null;
  last_error: string | null;
};

const ACTIVE_SYNC_STATUSES = new Set(["queued", "fetching", "processing"]);

const syncStatusLabel = (status: SyncRun["status"]): string => {
  if (status === "queued") return "Queued — starting in ~30s…";
  if (status === "fetching") return "Fetching vendors from QuickBooks…";
  if (status === "processing") return "Processing vendors…";
  if (status === "completed") return "Sync completed";
  if (status === "failed") return "Sync failed";
  return "Sync cancelled";
};

type QbVendor = {
  id: string;
  qb_list_id: string;
  full_name: string;
  name: string;
  company_name: string | null;
  account_number: string | null;
  is_active: boolean;
  first_name: string | null;
  last_name: string | null;
  contact: string | null;
  email: string | null;
  phone: string | null;
  city: string | null;
  state: string | null;
  terms_ref_name: string | null;
  prefill_account_ref_name: string | null;
  vendor_type_ref_name: string | null;
  last_synced_at: string | null;
};

const VendorsPage = () => {
  const navigate = useNavigate();
  const [vendors, setVendors] = useState<QbVendor[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [syncRun, setSyncRun] = useState<SyncRun | null>(null);
  const [startingSync, setStartingSync] = useState(false);
  const [meiliSyncing, setMeiliSyncing] = useState(false);
  const pollTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const syncing = syncRun != null && ACTIVE_SYNC_STATUSES.has(syncRun.status);

  const fetchVendors = async () => {
    setLoading(true);
    try {
      const res = await fetch("/admin/qb-catalog/vendors", {
        credentials: "include",
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setVendors(data.vendors ?? []);
    } catch (e) {
      toast.error("Failed to load vendors", {
        description: (e as Error).message,
      });
    } finally {
      setLoading(false);
    }
  };

  const fetchLatestRun = async (): Promise<SyncRun | null> => {
    try {
      const res = await fetch("/admin/qb-catalog/vendors/sync", {
        credentials: "include",
      });
      if (!res.ok) return null;
      const data = await res.json();
      return (data.run as SyncRun | null) ?? null;
    } catch {
      return null;
    }
  };

  // Load vendors + restore sync state on mount.
  useEffect(() => {
    fetchVendors();
    fetchLatestRun().then((r) => setSyncRun(r));
  }, []);

  // Poll progress every 3s while a sync is active.
  useEffect(() => {
    if (pollTimerRef.current) {
      clearInterval(pollTimerRef.current);
      pollTimerRef.current = null;
    }
    if (!syncing || !syncRun) return;
    pollTimerRef.current = setInterval(async () => {
      const fresh = await fetchLatestRun();
      if (!fresh) return;
      setSyncRun(fresh);
      if (!ACTIVE_SYNC_STATUSES.has(fresh.status)) {
        // Sync just finished — reload the vendor list.
        fetchVendors();
        if (fresh.status === "completed") {
          toast.success("Vendor sync completed", {
            description: `Created ${fresh.created_count}, updated ${fresh.updated_count}, errors ${fresh.error_count}`,
          });
        } else if (fresh.status === "failed") {
          toast.error("Vendor sync failed", {
            description: fresh.last_error ?? "Unknown error",
          });
        }
      }
    }, 3000);
    return () => {
      if (pollTimerRef.current) clearInterval(pollTimerRef.current);
      pollTimerRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [syncing, syncRun?.id]);

  const filtered = useMemo(() => {
    if (!search.trim()) return vendors;
    const s = search.toLowerCase();
    return vendors.filter((v) => {
      const hay = [
        v.full_name,
        v.company_name,
        v.email,
        v.phone,
        v.contact,
        v.first_name,
        v.last_name,
        v.city,
        v.state,
      ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
      return hay.includes(s);
    });
  }, [vendors, search]);

  const handleSync = async () => {
    setStartingSync(true);
    try {
      const res = await fetch("/admin/qb-catalog/vendors/sync", {
        method: "POST",
        credentials: "include",
      });
      const data = await res.json();
      if (res.status === 409) {
        toast.info("A vendor sync is already running", {
          description: "Progress shown above.",
        });
      } else if (!res.ok || !data.success) {
        throw new Error(data.error ?? "Failed to start sync");
      } else {
        toast.success("Sync queued", { description: data.message });
      }
      const fresh = await fetchLatestRun();
      setSyncRun(fresh);
    } catch (e) {
      toast.error("Failed to start sync", {
        description: (e as Error).message,
      });
    } finally {
      setStartingSync(false);
    }
  };

  const handleCancel = async () => {
    if (!syncRun) return;
    try {
      const res = await fetch(
        `/admin/qb-catalog/vendors/sync/${syncRun.id}`,
        { method: "DELETE", credentials: "include" }
      );
      const data = await res.json();
      if (!res.ok || !data.success) {
        throw new Error(data.error ?? "Cancel failed");
      }
      toast.success("Sync cancelled");
      const fresh = await fetchLatestRun();
      setSyncRun(fresh);
    } catch (e) {
      toast.error("Failed to cancel sync", {
        description: (e as Error).message,
      });
    }
  };

  const handleMeiliSync = async () => {
    setMeiliSyncing(true);
    try {
      const res = await fetch("/admin/qb-catalog/vendors/sync-meili", {
        method: "POST",
        credentials: "include",
      });
      const data = await res.json();
      if (!res.ok || data.ok === false) {
        throw new Error(data.error ?? "Meilisearch sync failed");
      }
      toast.success("Meilisearch index refreshed", {
        description: `${data.synced ?? 0} vendor(s) upserted`,
      });
    } catch (e) {
      toast.error("Meilisearch sync failed", {
        description: (e as Error).message,
      });
    } finally {
      setMeiliSyncing(false);
    }
  };

  const handleMeiliSyncSingle = async (vendorId: string, label: string) => {
    try {
      const res = await fetch(
        `/admin/qb-catalog/vendors/${vendorId}/sync-meili`,
        { method: "POST", credentials: "include" }
      );
      const data = await res.json();
      if (!res.ok || data.ok === false) {
        throw new Error(data.error ?? "Meilisearch sync failed");
      }
      toast.success(`${label} re-indexed to Meilisearch`);
    } catch (e) {
      toast.error("Vendor re-index failed", {
        description: (e as Error).message,
      });
    }
  };

  const displayName = (v: QbVendor) => {
    const parts = [v.first_name, v.last_name].filter(Boolean).join(" ");
    return parts || v.contact || "—";
  };

  const location = (v: QbVendor) => {
    return [v.city, v.state].filter(Boolean).join(", ") || "—";
  };

  return (
    <div className="flex flex-col gap-4 p-6">
      <div className="flex items-start justify-between">
        <div>
          <Heading level="h1">Vendors</Heading>
          <Text className="text-ui-fg-subtle mt-1">
            QuickBooks vendor catalog cached locally. Used for purchase orders
            and preferred vendor assignment in POS product creation.
          </Text>
        </div>
        <div className="flex flex-col items-end gap-1">
          <div className="flex items-center gap-2">
            <Button
              variant="secondary"
              onClick={handleSync}
              isLoading={startingSync}
              disabled={startingSync || syncing}
            >
              <ArrowPath className={syncing ? "animate-spin" : undefined} />
              {syncing ? "Syncing Vendors…" : "Sync from QuickBooks"}
            </Button>
            <Button
              variant="secondary"
              onClick={handleMeiliSync}
              isLoading={meiliSyncing}
              disabled={meiliSyncing}
              title="Re-index every vendor into the Meilisearch vendors index"
            >
              <ArrowPath className={meiliSyncing ? "animate-spin" : undefined} />
              {meiliSyncing ? "Refreshing Meili…" : "Sync Meilisearch"}
            </Button>
            {syncing && (
              <Button variant="danger" size="small" onClick={handleCancel}>
                Cancel
              </Button>
            )}
          </div>
          {syncing && (
            <Text className="text-ui-fg-subtle text-xs">
              Safe to close this tab — sync runs in the background.
            </Text>
          )}
        </div>
      </div>

      {syncRun && (
        <SyncProgressPanel run={syncRun} />
      )}

      <Container className="p-0">
        <div className="flex items-center gap-3 px-6 py-3 border-b border-ui-border-base">
          <Input
            placeholder="Search by name, company, email, phone, contact…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="max-w-md"
          />
          <Text className="text-ui-fg-subtle text-sm ml-auto">
            {filtered.length} {filtered.length === 1 ? "vendor" : "vendors"}
          </Text>
        </div>

        {loading && (
          <Text className="text-ui-fg-subtle py-6 px-6">Loading…</Text>
        )}
        {!loading && filtered.length === 0 && (
          <Text className="text-ui-fg-subtle py-6 px-6">
            No vendors found. Click "Sync from QuickBooks" to populate.
          </Text>
        )}
        {!loading && filtered.length > 0 && (
          <div className="max-h-[calc(100vh-280px)] overflow-y-auto">
            <Table>
              <Table.Header>
                <Table.Row>
                  <Table.HeaderCell>Vendor</Table.HeaderCell>
                  <Table.HeaderCell>Company</Table.HeaderCell>
                  <Table.HeaderCell>Contact</Table.HeaderCell>
                  <Table.HeaderCell>Phone</Table.HeaderCell>
                  <Table.HeaderCell>Email</Table.HeaderCell>
                  <Table.HeaderCell>Location</Table.HeaderCell>
                  <Table.HeaderCell>Terms</Table.HeaderCell>
                  <Table.HeaderCell>Status</Table.HeaderCell>
                  <Table.HeaderCell>Actions</Table.HeaderCell>
                </Table.Row>
              </Table.Header>
              <Table.Body>
                {filtered.map((v) => (
                  <Table.Row
                    key={v.id}
                    className="cursor-pointer hover:bg-ui-bg-base-hover"
                    onClick={() => navigate(`/vendors/${v.id}`)}
                  >
                    <Table.Cell>
                      <span className="font-medium">{v.full_name}</span>
                    </Table.Cell>
                    <Table.Cell className="text-ui-fg-subtle">
                      {v.company_name || "—"}
                    </Table.Cell>
                    <Table.Cell className="text-ui-fg-subtle">
                      {displayName(v)}
                    </Table.Cell>
                    <Table.Cell className="text-ui-fg-subtle">
                      {v.phone || "—"}
                    </Table.Cell>
                    <Table.Cell className="text-ui-fg-subtle">
                      {v.email || "—"}
                    </Table.Cell>
                    <Table.Cell className="text-ui-fg-subtle">
                      {location(v)}
                    </Table.Cell>
                    <Table.Cell className="text-ui-fg-subtle">
                      {v.terms_ref_name || "—"}
                    </Table.Cell>
                    <Table.Cell>
                      {v.is_active ? (
                        <Badge color="green" size="2xsmall">
                          Active
                        </Badge>
                      ) : (
                        <Badge color="grey" size="2xsmall">
                          Inactive
                        </Badge>
                      )}
                    </Table.Cell>
                    <Table.Cell
                      onClick={(e) => e.stopPropagation()}
                      className="text-right"
                    >
                      <Button
                        variant="transparent"
                        size="small"
                        onClick={() =>
                          handleMeiliSyncSingle(v.id, v.full_name)
                        }
                        title="Re-index this vendor in Meilisearch"
                      >
                        <ArrowPath />
                        <span className="text-xs">Re-index</span>
                      </Button>
                    </Table.Cell>
                  </Table.Row>
                ))}
              </Table.Body>
            </Table>
          </div>
        )}
      </Container>
    </div>
  );
};

const SyncProgressPanel = ({ run }: { run: SyncRun }) => {
  const active = ACTIVE_SYNC_STATUSES.has(run.status);
  const pct = run.total_count > 0
    ? Math.min(100, Math.round((run.processed_count / run.total_count) * 100))
    : run.status === "fetching" ? 5 : run.status === "queued" ? 1 : 100;

  const barColor =
    run.status === "completed" ? "bg-ui-tag-green-bg"
    : run.status === "failed" ? "bg-ui-tag-red-bg"
    : run.status === "cancelled" ? "bg-ui-bg-base-pressed"
    : "bg-ui-tag-blue-bg";

  const tone: "green" | "red" | "orange" | "blue" | "grey" =
    run.status === "completed" ? "green"
    : run.status === "failed" ? "red"
    : run.status === "cancelled" ? "grey"
    : run.status === "queued" ? "orange"
    : "blue";

  const fmt = (iso: string | null): string => iso ? new Date(iso).toLocaleString() : "—";

  return (
    <Container className="p-4 flex flex-col gap-3">
      <div className="flex items-center gap-3">
        <Badge color={tone} size="small">{run.status}</Badge>
        <Text className="text-ui-fg-base text-sm font-medium">
          {syncStatusLabel(run.status)}
        </Text>
        <Text className="text-ui-fg-subtle text-xs ml-auto">
          {run.total_count > 0
            ? `${run.processed_count.toLocaleString()} / ${run.total_count.toLocaleString()} vendors`
            : active ? "Waiting for QuickBooks…" : "—"}
        </Text>
      </div>

      <div className="w-full h-2 rounded-full bg-ui-bg-subtle overflow-hidden">
        <div
          className={`h-full ${barColor} transition-all duration-500`}
          style={{ width: `${pct}%` }}
        />
      </div>

      <div className="grid grid-cols-4 gap-4 text-xs">
        <div>
          <Text className="text-ui-fg-subtle">Created</Text>
          <Text className="font-mono">{run.created_count.toLocaleString()}</Text>
        </div>
        <div>
          <Text className="text-ui-fg-subtle">Updated</Text>
          <Text className="font-mono">{run.updated_count.toLocaleString()}</Text>
        </div>
        <div>
          <Text className="text-ui-fg-subtle">Errors</Text>
          <Text className="font-mono">{run.error_count.toLocaleString()}</Text>
        </div>
        <div>
          <Text className="text-ui-fg-subtle">Started</Text>
          <Text className="font-mono">{fmt(run.started_at)}</Text>
        </div>
      </div>

      {run.last_error && (
        <Text className="text-ui-fg-error text-xs font-mono border-l-2 border-ui-tag-red-border pl-2">
          {run.last_error}
        </Text>
      )}
    </Container>
  );
};

export const config = defineRouteConfig({
  label: "Vendors",
  icon: BuildingTax,
});

export default VendorsPage;
