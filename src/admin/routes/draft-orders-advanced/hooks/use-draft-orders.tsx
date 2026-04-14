import { useState, useEffect, useMemo } from "react";
import { useNavigate } from "react-router-dom";

export interface DraftOrderListItem {
  id: string;
  display_id: number;
  status: string;
  email?: string;
  currency_code?: string;
  total?: number;
  created_at: string;
  metadata?: Record<string, any>;
  customer?: {
    first_name?: string;
    last_name?: string;
    email?: string;
    company_name?: string;
    phone?: string;
  };
  sales_channel?: { name?: string };
  region?: { name?: string };
}

export type SortKey =
  | "display_id_desc"
  | "display_id_asc"
  | "created_at_desc"
  | "created_at_asc"
  | "total_desc"
  | "total_asc";

export const SORT_OPTIONS: { value: SortKey; label: string }[] = [
  { value: "display_id_desc", label: "# (Newest first)" },
  { value: "display_id_asc", label: "# (Oldest first)" },
  { value: "created_at_desc", label: "Date (Newest)" },
  { value: "created_at_asc", label: "Date (Oldest)" },
  { value: "total_desc", label: "Total (High → Low)" },
  { value: "total_asc", label: "Total (Low → High)" },
];

export const PAGE_SIZE = 20;

export const useDraftOrders = () => {
  const navigate = useNavigate();
  const [orders, setOrders] = useState<DraftOrderListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [sort, setSort] = useState<SortKey>("display_id_desc");
  const [page, setPage] = useState(0);
  // Default: hide "Not Approved" and "Cancelled" orders — they are closed/declined estimates
  const [showNotApproved, setShowNotApproved] = useState(false);
  const [showCancelled, setShowCancelled] = useState(false);

  useEffect(() => {
    const load = async () => {
      setLoading(true);
      try {
        const resp = await fetch(
          `/admin/draft-orders?limit=250&fields=id,display_id,status,email,currency_code,total,created_at,metadata,+customer.first_name,+customer.last_name,+customer.email,+customer.phone,+customer.company_name,+sales_channel.name`,
          { credentials: "include" }
        );
        const json = await resp.json();
        setOrders(json.draft_orders ?? []);
      } catch (err) {
        console.error("Failed to fetch draft orders", err);
      } finally {
        setLoading(false);
      }
    };
    load();
    // Poll every 60s so the list reflects compute-tax updates after saves (reduced from 10s to save backend load)
    const interval = setInterval(load, 60_000);
    return () => clearInterval(interval);
  }, []);

  const filtered = useMemo(() => {
    let list = orders;

    // By default, hide orders with estimate_status = "Not Approved" or "Cancelled"
    if (!showNotApproved) {
      list = list.filter((o) => {
        const s = o.metadata?.order_status ?? o.metadata?.estimate_status;
        return s !== "Not Approved" && s !== "not_approved";
      });
    }
    if (!showCancelled) {
      list = list.filter((o) => {
        const s = o.metadata?.order_status ?? o.metadata?.estimate_status;
        return s !== "Cancelled" && s !== "cancelled";
      });
    }

    if (!search.trim()) return list;
    const q = search.toLowerCase();
    return list.filter((o) => {
      const name =
        `${o.customer?.first_name ?? ""} ${o.customer?.last_name ?? ""}`
          .trim()
          .toLowerCase();
      const email = (o.customer?.email ?? o.email ?? "").toLowerCase();
      const phone = (o.customer?.phone ?? "").replace(/[^\d]/g, "");
      const searchDigits = search.replace(/[^\d]/g, "");
      return (
        name.includes(q) ||
        email.includes(q) ||
        `#${o.display_id}`.includes(q) ||
        (searchDigits.length > 0 && phone.includes(searchDigits))
      );
    });
  }, [orders, search, showNotApproved, showCancelled]);

  const sorted = useMemo(() => {
    const arr = [...filtered];
    switch (sort) {
      case "display_id_desc":
        return arr.sort((a, b) => b.display_id - a.display_id);
      case "display_id_asc":
        return arr.sort((a, b) => a.display_id - b.display_id);
      case "created_at_desc":
        return arr.sort(
          (a, b) =>
            new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
        );
      case "created_at_asc":
        return arr.sort(
          (a, b) =>
            new Date(a.created_at).getTime() - new Date(b.created_at).getTime()
        );
      case "total_desc":
        return arr.sort(
          (a, b) =>
            Number(b.metadata?.computed_total ?? b.total ?? 0) -
            Number(a.metadata?.computed_total ?? a.total ?? 0)
        );
      case "total_asc":
        return arr.sort(
          (a, b) =>
            Number(a.metadata?.computed_total ?? a.total ?? 0) -
            Number(b.metadata?.computed_total ?? b.total ?? 0)
        );
    }
  }, [filtered, sort]);

  // Count of hidden orders for toggle labels
  const notApprovedCount = useMemo(
    () =>
      orders.filter((o) => {
        const s = o.metadata?.order_status ?? o.metadata?.estimate_status;
        return s === "Not Approved" || s === "not_approved";
      }).length,
    [orders]
  );
  const cancelledCount = useMemo(
    () =>
      orders.filter((o) => {
        const s = o.metadata?.order_status ?? o.metadata?.estimate_status;
        return s === "Cancelled" || s === "cancelled";
      }).length,
    [orders]
  );

  const totalPages = Math.ceil(sorted.length / PAGE_SIZE);
  const paginated = sorted.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);

  return {
    navigate,
    orders,
    loading,
    search,
    setSearch,
    sort,
    setSort,
    page,
    setPage,
    filtered,
    sorted,
    paginated,
    totalPages,
    showNotApproved,
    setShowNotApproved,
    showCancelled,
    setShowCancelled,
    notApprovedCount,
    cancelledCount,
  };
};
