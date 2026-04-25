import { defineRouteConfig } from "@medusajs/admin-sdk";
import { ArrowsPointingOut, Plus } from "@medusajs/icons";
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

type AlternativeRow = {
  primary_variant_id: string;
  sku: string;
  product_title: string;
  alt_count: number;
  inv_usa: number;
  inv_china: number;
  alt_inv_usa: number;
  abc_class: string | null;
  xyz_class: string | null;
};

const classBadgeColor = (
  cls: string | null
): "green" | "blue" | "orange" | "red" | "grey" => {
  if (!cls) return "grey";
  const c = cls.toUpperCase();
  if (c.startsWith("A")) return "green";
  if (c.startsWith("B")) return "blue";
  if (c.startsWith("C")) return "orange";
  return "grey";
};

const PurchasingAlternativesPage = () => {
  const navigate = useNavigate();
  const [rows, setRows] = useState<AlternativeRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");

  const fetchList = async () => {
    setLoading(true);
    try {
      const res = await fetch("/admin/purchasing/alternatives", {
        credentials: "include",
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setRows(data.alternatives ?? []);
    } catch (e) {
      toast.error("Failed to load alternatives", {
        description: (e as Error).message,
      });
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchList();
  }, []);

  const filtered = useMemo(() => {
    if (!search.trim()) return rows;
    const s = search.toLowerCase();
    return rows.filter(
      (r) =>
        r.sku.toLowerCase().includes(s) ||
        r.product_title.toLowerCase().includes(s)
    );
  }, [rows, search]);

  const fmtQty = (n: number) => n.toLocaleString();

  return (
    <div className="flex flex-col gap-4 p-6">
      <div className="flex items-start justify-between">
        <div>
          <Heading level="h1">Product Alternatives</Heading>
          <Text className="text-ui-fg-subtle mt-1">
            Alternative SKU relationships. Sales from alternatives are added to
            the primary product's demand; their inventory is deducted from order
            quantities.
          </Text>
        </div>
      </div>

      <Container className="p-0">
        <div className="flex items-center gap-3 px-6 py-3 border-b border-ui-border-base">
          <Input
            placeholder="Search by SKU or product title…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="max-w-sm"
          />
          <Text className="text-ui-fg-subtle text-sm ml-auto">
            {filtered.length}{" "}
            {filtered.length === 1 ? "primary product" : "primary products"}
          </Text>
        </div>

        {loading && (
          <Text className="text-ui-fg-subtle py-6 px-6">Loading…</Text>
        )}
        {!loading && filtered.length === 0 && (
          <Text className="text-ui-fg-subtle py-6 px-6">
            No alternative relationships found. Open a product detail to link
            alternatives.
          </Text>
        )}
        {!loading && filtered.length > 0 && (
          <div className="max-h-[calc(100vh-240px)] overflow-y-auto">
            <Table>
              <Table.Header>
                <Table.Row>
                  <Table.HeaderCell>Primary SKU</Table.HeaderCell>
                  <Table.HeaderCell>Product</Table.HeaderCell>
                  <Table.HeaderCell className="text-right">
                    Alternatives
                  </Table.HeaderCell>
                  <Table.HeaderCell className="text-right">
                    Inv USA
                  </Table.HeaderCell>
                  <Table.HeaderCell className="text-right">
                    Alt Inv USA
                  </Table.HeaderCell>
                  <Table.HeaderCell className="text-right">
                    China WH
                  </Table.HeaderCell>
                  <Table.HeaderCell>Class</Table.HeaderCell>
                  <Table.HeaderCell />
                </Table.Row>
              </Table.Header>
              <Table.Body>
                {filtered.map((r) => (
                  <Table.Row
                    key={r.primary_variant_id}
                    className="cursor-pointer hover:bg-ui-bg-base-hover"
                    onClick={() =>
                      navigate(
                        `/purchasing-alternatives/${r.primary_variant_id}`
                      )
                    }
                  >
                    <Table.Cell>
                      <span className="font-mono text-sm font-medium">
                        {r.sku}
                      </span>
                    </Table.Cell>
                    <Table.Cell className="text-ui-fg-subtle max-w-xs truncate">
                      {r.product_title}
                    </Table.Cell>
                    <Table.Cell className="text-right">
                      <Badge color="blue" size="2xsmall">
                        {r.alt_count}
                      </Badge>
                    </Table.Cell>
                    <Table.Cell className="text-right font-mono text-sm">
                      {fmtQty(r.inv_usa)}
                    </Table.Cell>
                    <Table.Cell className="text-right font-mono text-sm text-ui-fg-subtle">
                      {fmtQty(r.alt_inv_usa)}
                    </Table.Cell>
                    <Table.Cell className="text-right font-mono text-sm text-ui-fg-subtle">
                      {fmtQty(r.inv_china)}
                    </Table.Cell>
                    <Table.Cell>
                      {r.abc_class ? (
                        <Badge
                          color={classBadgeColor(r.abc_class)}
                          size="2xsmall"
                        >
                          {r.abc_class}
                          {r.xyz_class ?? ""}
                        </Badge>
                      ) : (
                        <span className="text-ui-fg-subtle text-xs">—</span>
                      )}
                    </Table.Cell>
                    <Table.Cell className="text-right">
                      <Button
                        variant="transparent"
                        size="small"
                        onClick={(e) => {
                          e.stopPropagation();
                          navigate(
                            `/purchasing-alternatives/${r.primary_variant_id}`
                          );
                        }}
                      >
                        <ArrowsPointingOut />
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

export const config = defineRouteConfig({
  label: "Alternatives",
  icon: Plus,
});

export default PurchasingAlternativesPage;
