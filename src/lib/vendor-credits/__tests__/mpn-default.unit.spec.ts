import { resolveMpnDefaults } from "../mpn-default";

function fakeClient(rows: Array<{ id: string; metadata: Record<string, unknown> | null }>) {
  return {
    query: jest.fn(async () => ({ rows })),
  };
}

describe("resolveMpnDefaults", () => {
  it("returns the same array reference when nothing needs a lookup (no DB call)", async () => {
    const client = fakeClient([]);
    const lines = [{ line_type: "qb_account" as const, amount_cents: 100 }];
    const result = await resolveMpnDefaults(client as never, lines);
    expect(result).toBe(lines);
    expect(client.query).not.toHaveBeenCalled();
  });

  it("does not look up a product line that already has an mpn", async () => {
    const client = fakeClient([]);
    const lines = [
      { line_type: "product" as const, variant_id: "variant_1", mpn: "ALREADY-SET", amount_cents: 100 },
    ];
    const result = await resolveMpnDefaults(client as never, lines);
    expect(client.query).not.toHaveBeenCalled();
    expect(result[0]!.mpn).toBe("ALREADY-SET");
  });

  it("defaults mpn from product_variant.metadata->>'mpn' for a product line without one", async () => {
    const client = fakeClient([{ id: "variant_1", metadata: { mpn: "MPN-123", cbm: 0.5 } }]);
    const lines = [{ line_type: "product" as const, variant_id: "variant_1", amount_cents: 500 }];
    const result = await resolveMpnDefaults(client as never, lines);
    expect(result[0]!.mpn).toBe("MPN-123");
    // original array is untouched (immutable)
    expect(lines[0]!.mpn).toBeUndefined();
  });

  it("never invents an mpn from a non-string metadata value", async () => {
    const client = fakeClient([{ id: "variant_1", metadata: { mpn: 12345 } }]);
    const lines = [{ line_type: "product" as const, variant_id: "variant_1", amount_cents: 500 }];
    const result = await resolveMpnDefaults(client as never, lines);
    expect(result[0]!.mpn).toBeNull();
  });

  it("skips qb_account lines and product lines with no variant_id", async () => {
    const client = fakeClient([]);
    const lines = [
      { line_type: "qb_account" as const, qb_account_list_id: "80000001", amount_cents: 100 },
      { line_type: "product" as const, amount_cents: 200 },
    ];
    const result = await resolveMpnDefaults(client as never, lines);
    expect(client.query).not.toHaveBeenCalled();
    expect(result).toBe(lines);
  });

  it("dedupes variant ids into ONE query", async () => {
    const client = fakeClient([{ id: "variant_1", metadata: { mpn: "MPN-A" } }]);
    const lines = [
      { line_type: "product" as const, variant_id: "variant_1", amount_cents: 100 },
      { line_type: "product" as const, variant_id: "variant_1", amount_cents: 200 },
    ];
    const result = await resolveMpnDefaults(client as never, lines);
    expect(client.query).toHaveBeenCalledTimes(1);
    expect(result[0]!.mpn).toBe("MPN-A");
    expect(result[1]!.mpn).toBe("MPN-A");
  });
});
