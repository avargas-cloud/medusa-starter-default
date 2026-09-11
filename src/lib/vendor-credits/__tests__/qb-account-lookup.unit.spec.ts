import { resolveQbAccountsByListId } from "../qb-account-lookup";
import { VendorCreditError } from "../types";

function fakeClient(rows: Array<{ qb_list_id: string; full_name: string; account_type: string }>) {
  return { query: jest.fn(async () => ({ rows })) };
}

describe("resolveQbAccountsByListId", () => {
  it("returns an empty map without querying when given no list ids", async () => {
    const client = fakeClient([]);
    const result = await resolveQbAccountsByListId(client as never, []);
    expect(result.size).toBe(0);
    expect(client.query).not.toHaveBeenCalled();
  });

  it("resolves each list id to its full_name/account_type", async () => {
    const client = fakeClient([
      { qb_list_id: "80000001", full_name: "Sales:Sales Discounts", account_type: "Income" },
      { qb_list_id: "80000002", full_name: "Freight", account_type: "Expense" },
    ]);
    const result = await resolveQbAccountsByListId(client as never, ["80000001", "80000002"]);
    expect(result.get("80000001")).toEqual({ full_name: "Sales:Sales Discounts", account_type: "Income" });
    expect(result.get("80000002")).toEqual({ full_name: "Freight", account_type: "Expense" });
  });

  it("dedupes list ids into ONE query", async () => {
    const client = fakeClient([{ qb_list_id: "80000001", full_name: "Freight", account_type: "Expense" }]);
    await resolveQbAccountsByListId(client as never, ["80000001", "80000001"]);
    expect(client.query).toHaveBeenCalledTimes(1);
  });

  it("throws account_not_found (400) for any list id that doesn't resolve", async () => {
    const client = fakeClient([]);
    await expect(resolveQbAccountsByListId(client as never, ["gone"])).rejects.toMatchObject({
      code: "account_not_found",
      status: 400,
    });
    await expect(
      resolveQbAccountsByListId(client as never, ["gone"])
    ).rejects.toBeInstanceOf(VendorCreditError);
  });
});
