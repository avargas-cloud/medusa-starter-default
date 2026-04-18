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
import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";

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
      toast.error("Failed to load vendors", {
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
    setSyncing(true);
    try {
      const res = await fetch("/admin/qb-catalog/vendors/sync", {
        method: "POST",
        credentials: "include",
      });
      const data = await res.json();
      if (!res.ok || !data.success) {
        throw new Error(data.error ?? "Sync failed");
      }
      toast.success("Vendors synced", { description: data.message });
      fetchVendors();
    } catch (e) {
      toast.error("Sync failed", { description: (e as Error).message });
    } finally {
      setSyncing(false);
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
        <Button variant="secondary" onClick={handleSync} isLoading={syncing}>
          <ArrowPath />
          Sync from QuickBooks
        </Button>
      </div>

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

export const config = defineRouteConfig({
  label: "Vendors",
  icon: BuildingTax,
});

export default VendorsPage;
