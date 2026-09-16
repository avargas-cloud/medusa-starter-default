import type { PoolClient } from "pg";

import { reconcilePurchaseDrift } from "../drift";
import { currentVendorBillSourceHash } from "../documents/vendor-bill";

jest.mock("../documents/vendor-bill", () => ({
  currentVendorBillSourceHash: jest.fn(),
  postVendorBill: jest.fn(),
  reverseVendorBill: jest.fn(),
}));

const mockedCurrentHash = currentVendorBillSourceHash as jest.Mock;

/**
 * 2026-09-16 (VB-1149): la selección de candidatos del drift era
 * `ORDER BY e.created_at LIMIT 200` — un asiento activo cuyo bill se
 * reconfirmó/editó DESPUÉS de postearse podía quedar fuera del corte para
 * siempre si había 200+ asientos más viejos. Este spec fija un `PoolClient`
 * fake que ejecuta EN JS la misma semántica del SQL nuevo (join contra
 * `vendor_bill` vivo + `updated_at` del bill o una `vendor_bill_revision`
 * posterior al posting), para no depender de una DB real.
 */

interface Entry {
  source_id: string;
  source_hash: string;
  created_at: Date;
  reversed: boolean;
}

interface Bill {
  id: string;
  updated_at: Date;
  deleted_at: Date | null;
}

interface Revision {
  vendor_bill_id: string;
  created_at: Date;
}

function fakeClient(fixtures: {
  entries: Entry[];
  bills: Bill[];
  revisions: Revision[];
}): { client: PoolClient; calledIds: string[] } {
  const calledIds: string[] = [];
  const billById = new Map(fixtures.bills.map((b) => [b.id, b]));

  const client = {
    query: jest.fn(async (sql: string, params?: unknown[]) => {
      // La query de selección de candidatos del reconciler.
      if (sql.includes("FROM bank_journal_entry e") && sql.includes("JOIN vendor_bill b")) {
        const limit = (params?.[0] as number) ?? 200;
        const rows = fixtures.entries
          .filter((e) => !e.reversed)
          .filter((e) => {
            const bill = billById.get(e.source_id);
            if (!bill || bill.deleted_at) return false;
            const billChangedAfterPost = bill.updated_at > e.created_at;
            const revisionAfterPost = fixtures.revisions.some(
              (vr) => vr.vendor_bill_id === e.source_id && vr.created_at > e.created_at
            );
            return billChangedAfterPost || revisionAfterPost;
          })
          .sort((a, b) => {
            const ba = billById.get(a.source_id)!.updated_at.getTime();
            const bb = billById.get(b.source_id)!.updated_at.getTime();
            return bb - ba;
          })
          .slice(0, limit)
          .map((e) => ({ source_id: e.source_id, source_hash: e.source_hash }));
        return { rows };
      }
      return { rows: [] };
    }),
  } as unknown as PoolClient;

  // `currentVendorBillSourceHash` se llama por cada candidato — grabamos el
  // id para saber exactamente cuáles entraron al loop del reconciler.
  mockedCurrentHash.mockImplementation(async (_c: unknown, id: unknown) => {
    calledIds.push(id as string);
    // Mismo hash que el guardado → sin drift, no se toca nada más.
    const entry = fixtures.entries.find((e) => e.source_id === id);
    return entry?.source_hash ?? null;
  });

  return { client, calledIds };
}

const OLD = new Date("2026-01-01T00:00:00Z");
const NEW = new Date("2026-09-15T00:00:00Z");

describe("reconcilePurchaseDrift — selección de candidatos", () => {
  afterEach(() => jest.clearAllMocks());

  it("revisa el asiento #201 cuyo bill cambió DESPUÉS de postearse, aunque haya 200 sin cambios antes", async () => {
    const entries: Entry[] = Array.from({ length: 200 }, (_, i) => ({
      source_id: `vb_unchanged_${i}`,
      source_hash: "hash",
      created_at: OLD,
      reversed: false,
    }));
    entries.push({
      source_id: "vb_1149",
      source_hash: "hash",
      created_at: OLD,
      reversed: false,
    });

    const bills: Bill[] = [
      ...entries
        .slice(0, 200)
        .map((e) => ({ id: e.source_id, updated_at: OLD, deleted_at: null })),
      // VB-1149: reconfirmado/editado DESPUÉS del posting original.
      { id: "vb_1149", updated_at: NEW, deleted_at: null },
    ];

    const { client, calledIds } = fakeClient({ entries, bills, revisions: [] });

    const report = await reconcilePurchaseDrift(client, { limit: 200 });

    expect(report.checked).toBe(1);
    expect(calledIds).toEqual(["vb_1149"]);
  });

  it("no revisa un asiento cuyo bill NO cambió desde que se posteó", async () => {
    const entries: Entry[] = [
      { source_id: "vb_stable", source_hash: "hash", created_at: NEW, reversed: false },
    ];
    const bills: Bill[] = [{ id: "vb_stable", updated_at: OLD, deleted_at: null }];

    const { client, calledIds } = fakeClient({ entries, bills, revisions: [] });

    const report = await reconcilePurchaseDrift(client, { limit: 200 });

    expect(report.checked).toBe(0);
    expect(calledIds).toEqual([]);
  });

  it("revisa un asiento cuyo bill no cambió pero tiene una vendor_bill_revision posterior al posting (reconfirm)", async () => {
    const entries: Entry[] = [
      { source_id: "vb_reconfirmed", source_hash: "hash", created_at: OLD, reversed: false },
    ];
    const bills: Bill[] = [{ id: "vb_reconfirmed", updated_at: OLD, deleted_at: null }];
    const revisions: Revision[] = [{ vendor_bill_id: "vb_reconfirmed", created_at: NEW }];

    const { client, calledIds } = fakeClient({ entries, bills, revisions });

    const report = await reconcilePurchaseDrift(client, { limit: 200 });

    expect(report.checked).toBe(1);
    expect(calledIds).toEqual(["vb_reconfirmed"]);
  });
});
