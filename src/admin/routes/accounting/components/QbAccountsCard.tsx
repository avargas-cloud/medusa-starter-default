import { ArrowPath } from "@medusajs/icons";
import {
  Badge,
  Button,
  Container,
  Heading,
  Input,
  Select,
  Table,
  Text,
  toast,
} from "@medusajs/ui";
import { useEffect, useMemo, useState } from "react";

type QbAccount = {
  id: string;
  qb_list_id: string;
  full_name: string;
  name: string;
  account_type: string;
  parent_full_name: string | null;
  is_active: boolean;
  last_synced_at: string | null;
};

const ALL_TYPES = "__all__";

const TYPE_OPTIONS = [
  { label: "All types", value: ALL_TYPES },
  { label: "Income", value: "Income" },
  { label: "Cost of Goods Sold", value: "CostOfGoodsSold" },
  { label: "Expense", value: "Expense" },
  { label: "Bank", value: "Bank" },
  { label: "Other Current Liability", value: "OtherCurrentLiability" },
];

export const QbAccountsCard = () => {
  const [accounts, setAccounts] = useState<QbAccount[]>([]);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [search, setSearch] = useState("");
  const [typeFilter, setTypeFilter] = useState(ALL_TYPES);

  const fetchAccounts = async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (typeFilter && typeFilter !== ALL_TYPES)
        params.set("type", typeFilter);
      const res = await fetch(`/admin/qb-catalog/accounts?${params}`, {
        credentials: "include",
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setAccounts(data.accounts ?? []);
    } catch (e) {
      toast.error("Failed to load QB accounts", {
        description: (e as Error).message,
      });
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchAccounts();
  }, [typeFilter]);

  const filtered = useMemo(() => {
    if (!search) return accounts;
    const s = search.toLowerCase();
    return accounts.filter((a) => a.full_name.toLowerCase().includes(s));
  }, [accounts, search]);

  const handleSync = async () => {
    setSyncing(true);
    try {
      const res = await fetch("/admin/qb-catalog/accounts/sync", {
        method: "POST",
        credentials: "include",
      });
      const data = await res.json();
      if (!res.ok || !data.success)
        throw new Error(data.error ?? "Sync failed");
      toast.success("QuickBooks accounts synced", {
        description: data.message,
      });
      fetchAccounts();
    } catch (e) {
      toast.error("Sync failed", { description: (e as Error).message });
    } finally {
      setSyncing(false);
    }
  };

  const hierarchyLevel = (fullName: string) => fullName.split(":").length - 1;

  return (
    <Container className="p-0">
      <div className="flex items-center justify-between px-6 py-4 border-b border-ui-border-base">
        <div>
          <Heading level="h2">QuickBooks Accounts</Heading>
          <Text className="text-ui-fg-subtle text-sm mt-1">
            Chart of Accounts cached locally. Used to populate COGS / Income /
            Expense dropdowns when creating products from the POS.
          </Text>
        </div>
        <Button variant="secondary" onClick={handleSync} isLoading={syncing}>
          <ArrowPath />
          Sync from QuickBooks
        </Button>
      </div>

      <div className="flex items-center gap-3 px-6 py-3 border-b border-ui-border-base">
        <Input
          placeholder="Search by name…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="max-w-xs"
        />
        <Select value={typeFilter} onValueChange={setTypeFilter}>
          <Select.Trigger className="max-w-xs">
            <Select.Value placeholder="All types" />
          </Select.Trigger>
          <Select.Content>
            {TYPE_OPTIONS.map((t) => (
              <Select.Item key={t.value} value={t.value}>
                {t.label}
              </Select.Item>
            ))}
          </Select.Content>
        </Select>
        <Text className="text-ui-fg-subtle text-sm ml-auto">
          {filtered.length} {filtered.length === 1 ? "account" : "accounts"}
        </Text>
      </div>

      <div className="max-h-[520px] overflow-y-auto">
        {loading && (
          <Text className="text-ui-fg-subtle py-6 px-6">Loading…</Text>
        )}
        {!loading && filtered.length === 0 && (
          <Text className="text-ui-fg-subtle py-6 px-6">
            No accounts. Click "Sync from QuickBooks" to populate.
          </Text>
        )}
        {!loading && filtered.length > 0 && (
          <Table>
            <Table.Header>
              <Table.Row>
                <Table.HeaderCell>Account (FullName)</Table.HeaderCell>
                <Table.HeaderCell>Type</Table.HeaderCell>
                <Table.HeaderCell>ListID</Table.HeaderCell>
                <Table.HeaderCell>Status</Table.HeaderCell>
              </Table.Row>
            </Table.Header>
            <Table.Body>
              {filtered.map((a) => (
                <Table.Row key={a.id}>
                  <Table.Cell>
                    <span
                      style={{
                        paddingLeft: `${hierarchyLevel(a.full_name) * 16}px`,
                      }}
                      className="font-mono text-sm"
                    >
                      {a.full_name}
                    </span>
                  </Table.Cell>
                  <Table.Cell>
                    <Badge size="2xsmall">{a.account_type}</Badge>
                  </Table.Cell>
                  <Table.Cell>
                    <code className="text-xs text-ui-fg-subtle">
                      {a.qb_list_id}
                    </code>
                  </Table.Cell>
                  <Table.Cell>
                    {a.is_active ? (
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
        )}
      </div>
    </Container>
  );
};
