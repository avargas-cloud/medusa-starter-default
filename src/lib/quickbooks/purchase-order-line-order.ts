export type PurchaseOrderModLineLike = {
  qb_txn_line_id?: string | null;
};

type SortKey = {
  numeric: number | null;
  raw: string;
};

function getExistingLineSortKey(line: PurchaseOrderModLineLike): SortKey | null {
  const txnLineId = line.qb_txn_line_id;
  if (!txnLineId || txnLineId === "-1") return null;

  const raw = String(txnLineId);
  const firstSegment = raw.split("-")[0] ?? raw;
  const numeric = /^[0-9a-f]+$/i.test(firstSegment)
    ? parseInt(firstSegment, 16)
    : null;

  return { numeric, raw };
}

export function orderPurchaseOrderModLines<T extends PurchaseOrderModLineLike>(
  lines: readonly T[]
): T[] {
  return lines
    .map((line, index) => ({
      line,
      index,
      sortKey: getExistingLineSortKey(line),
    }))
    .sort((a, b) => {
      if (a.sortKey && !b.sortKey) return -1;
      if (!a.sortKey && b.sortKey) return 1;
      if (!a.sortKey || !b.sortKey) return a.index - b.index;

      if (a.sortKey.numeric !== null && b.sortKey.numeric !== null) {
        const numericDiff = a.sortKey.numeric - b.sortKey.numeric;
        if (numericDiff !== 0) return numericDiff;
      }

      const rawDiff = a.sortKey.raw.localeCompare(b.sortKey.raw);
      return rawDiff !== 0 ? rawDiff : a.index - b.index;
    })
    .map((entry) => entry.line);
}
