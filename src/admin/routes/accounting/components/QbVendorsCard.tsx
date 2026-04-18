import { ArrowPath } from "@medusajs/icons";
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
import { useEffect, useMemo, useState } from "react";

type QbVendor = {
  id: string;
  qb_list_id: string;
  full_name: string;
  name: string;
  company_name: string | null;
  account_number: string | null;
  is_active: boolean;
  last_synced_at: string | null;
};

export const QbVendorsCard = () => {
  const [vendors, setVendors] = useState<QbVendor[]>([]);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [search, setSearch] = useState("");

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
      toast.error("Failed to load QB vendors", {
        description: (e as Error).message,
      });
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchVendors();
  }, []);

  const filtered = useMemo(() => {
    if (!search) return vendors;
    const s = search.toLowerCase();
    return vendors.filter(
      (v) =>
        v.full_name.toLowerCase().includes(s) ||
        (v.company_name ?? "").toLowerCase().includes(s)
    );
  }, [vendors, search]);

  const handleSync = async () => {
    setSyncing(true);
    try {
      const res = await fetch("/admin/qb-catalog/vendors/sync", {
        method: "POST",
        credentials: "include",
      });
      const data = await res.json();
      if (!res.ok || !data.success) throw new Error(data.error ?? "Sync failed");
      toast.success("QuickBooks vendors synced", { description: data.message });
      fetchVendors();
    } catch (e) {
      toast.error("Sync failed", { description: (e as Error).message });
    } finally {
      setSyncing(false);
    }
  };

  return (
    <Container className="p-0">
      <div className="flex items-center justify-between px-6 py-4 border-b border-ui-border-base">
        <div>
          <Heading level="h2">QuickBooks Vendors</Heading>
          <Text className="text-ui-fg-subtle text-sm mt-1">
            Vendor list cached locally. Used to populate the Preferred Vendor dropdown
            when creating products from the POS.
          </Text>
        </div>
        <Button variant="secondary" onClick={handleSync} isLoading={syncing}>
          <ArrowPath />
          Sync from QuickBooks
        </Button>
      </div>

      <div className="flex items-center gap-3 px-6 py-3 border-b border-ui-border-base">
        <Input
          placeholder="Search by name or company…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="max-w-xs"
        />
        <Text className="text-ui-fg-subtle text-sm ml-auto">
          {filtered.length} {filtered.length === 1 ? "vendor" : "vendors"}
        </Text>
      </div>

      <div className="max-h-[520px] overflow-y-auto">
        {loading && (
          <Text className="text-ui-fg-subtle py-6 px-6">Loading…</Text>
        )}
        {!loading && filtered.length === 0 && (
          <Text className="text-ui-fg-subtle py-6 px-6">
            No vendors. Click "Sync from QuickBooks" to populate.
          </Text>
        )}
        {!loading && filtered.length > 0 && (
        <Table>
          <Table.Header>
            <Table.Row>
              <Table.HeaderCell>Vendor (FullName)</Table.HeaderCell>
              <Table.HeaderCell>Company</Table.HeaderCell>
              <Table.HeaderCell>ListID</Table.HeaderCell>
              <Table.HeaderCell>Status</Table.HeaderCell>
            </Table.Row>
          </Table.Header>
          <Table.Body>
            {filtered.map((v) => (
                <Table.Row key={v.id}>
                  <Table.Cell className="font-mono text-sm">{v.full_name}</Table.Cell>
                  <Table.Cell>{v.company_name ?? "—"}</Table.Cell>
                  <Table.Cell>
                    <code className="text-xs text-ui-fg-subtle">{v.qb_list_id}</code>
                  </Table.Cell>
                  <Table.Cell>
                    {v.is_active ? (
                      <Badge color="green" size="2xsmall">Active</Badge>
                    ) : (
                      <Badge color="grey" size="2xsmall">Inactive</Badge>
                    )}
                  </Table.Cell>
                </Table.Row>
              ))}
          </Table.Body>
        </Table>
        )}
      </div>
    </Container>
  );
};
