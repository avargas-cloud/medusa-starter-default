import { useEffect, useState } from "react";
import { Badge, Button, Container, Heading, Input, Text, Select } from "@medusajs/ui";

/**
 * Vendor Payment Terms — the double field.
 *
 * This gets its own panel instead of riding the generic context renderer for
 * one reason: a term is a NAME plus a RULE, and the generic renderer only knows
 * about `value`. It would list "Net-30" with no indication of whether that means
 * 30 days, and — worse — it would happily let someone rename it.
 *
 * RENAME IS DELIBERATELY NOT OFFERED HERE. The name is the join key to
 * QuickBooks: vendors carry it in `terms_ref_name`, and a VendorMod sending a
 * TermsRef that QuickBooks does not have is rejected outright. Renaming a term
 * used by 61 vendors would orphan all 61 at once, silently, and QuickBooks has
 * no rename that follows through. Create the correct term and move vendors onto
 * it instead.
 */

interface VendorTerm {
  id: string;
  name: string;
  days: number | null;
  day_of_month_due: number | null;
  due_next_month_days: number | null;
  exists_in_qb: boolean;
  /**
   * Still live in the QuickBooks Terms list. DISTINCT from `exists_in_qb`,
   * which only says the name is known there: a term QuickBooks has retired is
   * present and inactive at the same time, so the QuickBooks column alone reads
   * "present" for 16 of the 33 rows here and tells nobody they are dead.
   */
  is_active: boolean;
  sort_order: number;
}

interface TermsResponse {
  terms: VendorTerm[];
  rejected: { id: string; value: string }[];
  counts: { total: number; in_quickbooks: number; rejected: number };
}

const describeRule = (t: VendorTerm): string => {
  if (t.days != null) return t.days === 0 ? "due on receipt" : `${t.days} days`;
  if (t.day_of_month_due != null) return `due day ${t.day_of_month_due}`;
  return "no rule";
};

export const VendorTermsPanel = () => {
  const [data, setData] = useState<TermsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState("");
  const [kind, setKind] = useState<"standard" | "date_driven">("standard");
  const [rule, setRule] = useState("30");
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);

  const load = async () => {
    setLoading(true);
    try {
      const res = await fetch("/admin/vendor-terms", { credentials: "include" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setData((await res.json()) as TermsResponse);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
  }, []);

  const handleAdd = async () => {
    const value = Number(rule);
    if (!name.trim()) return setError("Name is required");
    if (!Number.isInteger(value)) return setError("The rule must be a whole number");
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/admin/vendor-terms", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(
          kind === "standard"
            ? { name: name.trim(), days: value }
            : { name: name.trim(), day_of_month_due: value }
        ),
      });
      const body = (await res.json()) as { error?: string };
      if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
      setName("");
      setAdding(false);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  /** Rule-only edit. Safe: it never touches the name QuickBooks joins on. */
  const handleEditRule = async (term: VendorTerm) => {
    const current = term.days ?? term.day_of_month_due ?? 0;
    const next = window.prompt(
      term.days != null
        ? `Days until due for "${term.name}" (0 = due on receipt):`
        : `Day of month "${term.name}" comes due (1-31):`,
      String(current)
    );
    if (next === null) return;
    const value = Number(next);
    if (!Number.isInteger(value)) {
      setError("The rule must be a whole number");
      return;
    }
    setBusy(true);
    try {
      const res = await fetch(`/admin/system-defaults/${term.id}`, {
        method: "PATCH",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          metadata:
            term.days != null
              ? {
                  days: value,
                  day_of_month_due: null,
                  due_next_month_days: null,
                  exists_in_qb: term.exists_in_qb,
                }
              : {
                  days: null,
                  day_of_month_due: value,
                  due_next_month_days: term.due_next_month_days,
                  exists_in_qb: term.exists_in_qb,
                },
        }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const handleDelete = async (term: VendorTerm) => {
    setBusy(true);
    try {
      const res = await fetch(`/admin/system-defaults/${term.id}`, {
        method: "DELETE",
        credentials: "include",
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setConfirmDelete(null);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-4 pt-6">
      <div className="flex items-center gap-2 border-b border-ui-border-base pb-2">
        <Heading level="h2" className="text-lg">
          Vendor Payment Terms
        </Heading>
        {data && (
          <>
            <Badge color="green">{data.counts.total} terms</Badge>
            {/* The count that answers "how many can anyone actually pick" —
                the pickers offer only the live ones. */}
            <Badge color="grey">
              {data.terms.filter((t) => t.is_active).length} active
            </Badge>
            <Badge color={data.counts.in_quickbooks === data.counts.total ? "green" : "orange"}>
              {data.counts.in_quickbooks} in QuickBooks
            </Badge>
            {data.counts.rejected > 0 && (
              <Badge color="red">{data.counts.rejected} broken</Badge>
            )}
          </>
        )}
      </div>

      <Text className="text-xs text-ui-fg-muted">
        One term carries both halves: the name QuickBooks knows it by, and the
        rule that turns a bill date into a due date. Renaming is not offered —
        the name is the join key to QuickBooks, so renaming a term would orphan
        every vendor using it. Create the right term and move vendors onto it.
      </Text>

      {error && (
        <Text className="text-xs text-ui-fg-error">{error}</Text>
      )}

      <Container className="p-0 overflow-hidden">
        {loading ? (
          <div className="p-4">
            <Text className="text-sm text-ui-fg-muted">Loading…</Text>
          </div>
        ) : (
          <table className="w-full text-sm">
            <thead className="bg-ui-bg-subtle border-b border-ui-border-base">
              <tr>
                <th className="text-left px-4 py-2 font-medium">Term</th>
                <th className="text-left px-4 py-2 font-medium">Rule</th>
                <th className="text-left px-4 py-2 font-medium">Status</th>
                <th className="text-left px-4 py-2 font-medium">QuickBooks</th>
                <th className="px-4 py-2" />
              </tr>
            </thead>
            <tbody>
              {(data?.terms ?? []).map((t) => (
                <tr key={t.id} className="border-b border-ui-border-base">
                  <td className="px-4 py-2">{t.name}</td>
                  <td className="px-4 py-2 text-ui-fg-subtle">{describeRule(t)}</td>
                  <td className="px-4 py-2">
                    {t.is_active ? (
                      <Badge color="green">Active</Badge>
                    ) : (
                      <Badge color="grey">Inactive</Badge>
                    )}
                  </td>
                  <td className="px-4 py-2">
                    {t.exists_in_qb ? (
                      <Badge color="green">present</Badge>
                    ) : (
                      <Badge color="orange">missing</Badge>
                    )}
                  </td>
                  <td className="px-4 py-2 text-right whitespace-nowrap">
                    <Button
                      variant="transparent"
                      size="small"
                      disabled={busy}
                      onClick={() => void handleEditRule(t)}
                    >
                      Edit rule
                    </Button>
                    {confirmDelete === t.id ? (
                      <>
                        <Button
                          variant="danger"
                          size="small"
                          disabled={busy}
                          onClick={() => void handleDelete(t)}
                        >
                          Really delete
                        </Button>
                        <Button
                          variant="transparent"
                          size="small"
                          onClick={() => setConfirmDelete(null)}
                        >
                          Cancel
                        </Button>
                      </>
                    ) : (
                      <Button
                        variant="transparent"
                        size="small"
                        disabled={busy}
                        onClick={() => setConfirmDelete(t.id)}
                      >
                        Delete
                      </Button>
                    )}
                  </td>
                </tr>
              ))}
              {(data?.rejected ?? []).map((r) => (
                <tr key={r.id} className="border-b border-ui-border-base bg-ui-bg-subtle">
                  <td className="px-4 py-2">{r.value}</td>
                  <td className="px-4 py-2 text-ui-fg-error" colSpan={3}>
                    no usable rule — not offered to anyone until fixed
                  </td>
                  <td className="px-4 py-2" />
                </tr>
              ))}
            </tbody>
          </table>
        )}

        <div className="p-3 border-t border-ui-border-base bg-ui-bg-field">
          {adding ? (
            <div className="flex flex-wrap items-center gap-2">
              <Input
                placeholder="Name, exactly as QuickBooks spells it"
                value={name}
                onChange={(e) => setName(e.target.value)}
                className="w-72"
              />
              <Select value={kind} onValueChange={(v) => setKind(v as typeof kind)}>
                <Select.Trigger className="w-40">
                  <Select.Value />
                </Select.Trigger>
                <Select.Content>
                  <Select.Item value="standard">Days until due</Select.Item>
                  <Select.Item value="date_driven">Day of month</Select.Item>
                </Select.Content>
              </Select>
              <Input
                type="number"
                value={rule}
                onChange={(e) => setRule(e.target.value)}
                className="w-24"
              />
              <Button size="small" disabled={busy} onClick={() => void handleAdd()}>
                {busy ? "Creating in QuickBooks…" : "Create"}
              </Button>
              <Button variant="transparent" size="small" onClick={() => setAdding(false)}>
                Cancel
              </Button>
              <Text className="w-full text-xs text-ui-fg-muted">
                Created in QuickBooks first. If QuickBooks refuses, nothing is
                saved here either — a term QuickBooks lacks would break every
                vendor assigned to it.
              </Text>
            </div>
          ) : (
            <Button
              variant="transparent"
              size="small"
              className="w-full text-ui-fg-muted text-xs h-7"
              onClick={() => setAdding(true)}
            >
              + Add payment term
            </Button>
          )}
        </div>
      </Container>
    </div>
  );
};
