/**
 * reverseVendorCredit — la reversa nunca se fecha ANTES del asiento activo.
 *
 * Caso real (Visa Regions 2084, 09/15/2026): `POST /vendor-credits/:id/revise`
 * movió `credit_date` de 09/07 a 08/04; el hook reversó con `header.credit_date`
 * (ya la nueva, 08/04) contra un asiento activo del 09/06 → el trigger
 * `gl_document_source_unique` rechaza `NEW.day < original.day` con
 * GL_SOURCE_INVALID, `runLedgerHook` lo traga con un warn y el documento queda
 * con fecha nueva y libro viejo. La reversa va en max(fecha pedida, día activo).
 */
import { reverseVendorCredit } from "../documents/vendor-credit";
import * as post from "../post";

jest.mock("../post", () => ({
  ...jest.requireActual("../post"),
  reverseDocumentJournal: jest.fn(async () => ({ status: "reversed", entry_id: "bje_rev" })),
  activeDocumentEntry: jest.fn(),
}));

const reverseDocumentJournal = post.reverseDocumentJournal as jest.Mock;
const activeDocumentEntry = post.activeDocumentEntry as jest.Mock;

function client(header: Record<string, unknown> | null) {
  return {
    query: jest.fn(async () => ({ rows: header ? [header] : [] })),
  } as unknown as Parameters<typeof reverseVendorCredit>[0];
}

const header = (credit_date: string, voided_at: string | null = null) => ({
  id: "vcr_1",
  number: "VC-1097",
  status: "posted",
  total_cents: "21141",
  credit_date,
  voided_at,
});

beforeEach(() => {
  reverseDocumentJournal.mockClear();
  activeDocumentEntry.mockReset();
});

describe("reverseVendorCredit — día de la reversa", () => {
  it("revise hacia ATRÁS: la reversa se fecha en el día del asiento activo, no en el credit_date nuevo", async () => {
    activeDocumentEntry.mockResolvedValue({ id: "bje_old", day: "2026-09-06", amount_cents: "21141" });
    await reverseVendorCredit(client(header("2026-08-04")), "vcr_1", "user_1", "vendor credit revised");
    expect(reverseDocumentJournal).toHaveBeenCalledTimes(1);
    expect(reverseDocumentJournal.mock.calls[0][1]).toMatchObject({
      source_kind: "vendor_credit",
      source_id: "vcr_1",
      day: "2026-09-06",
      reason: "vendor credit revised",
    });
  });

  it("revise hacia ADELANTE: la reversa se fecha en el credit_date pedido (≥ activo)", async () => {
    activeDocumentEntry.mockResolvedValue({ id: "bje_old", day: "2026-08-04", amount_cents: "21141" });
    await reverseVendorCredit(client(header("2026-09-07")), "vcr_1", "user_1");
    expect(reverseDocumentJournal.mock.calls[0][1]).toMatchObject({ day: "2026-09-07" });
  });

  it("void: la reversa se fecha en voided_at (≥ activo)", async () => {
    activeDocumentEntry.mockResolvedValue({ id: "bje_old", day: "2026-08-04", amount_cents: "21141" });
    await reverseVendorCredit(client(header("2026-08-04", "2026-09-15T14:00:00Z")), "vcr_1", "user_1");
    expect(reverseDocumentJournal.mock.calls[0][1]).toMatchObject({ day: "2026-09-15" });
  });

  it("sin asiento activo: usa la fecha pedida y deja que reverseDocumentJournal conteste nothing_to_reverse", async () => {
    activeDocumentEntry.mockResolvedValue(null);
    await reverseVendorCredit(client(header("2026-08-04")), "vcr_1", "user_1");
    expect(reverseDocumentJournal.mock.calls[0][1]).toMatchObject({ day: "2026-08-04" });
  });

  it("sin header: nothing_to_reverse sin tocar el libro", async () => {
    const r = await reverseVendorCredit(client(null), "vcr_x", "user_1");
    expect(r).toEqual({ status: "nothing_to_reverse" });
    expect(reverseDocumentJournal).not.toHaveBeenCalled();
  });
});
