import { Modules } from "@medusajs/utils";

export default async function myScript({ container }: { container: any }) {
  const customerModule = container.resolve(Modules.CUSTOMER);

  // Fetch the customer the user mentioned
  const customerId = "cus_01KJ3WJ707PA1NZQRD0ZYKEDPW";

  const customer = await customerModule.retrieveCustomer(customerId, {
    relations: ["addresses"],
  });

  const addrs = customer.addresses ?? [];
  const billingAddr = addrs.find(
    (a) => a.is_default_billing || a.metadata?.is_default_billing
  );
  const otherAddrs = addrs.filter(
    (a) => !(a.is_default_billing || a.metadata?.is_default_billing)
  );

  const mapBillAddr = (a: any) =>
    a
      ? {
          Addr1: a.address_1,
          Addr2: a.address_2,
          City: a.city,
          State: a.province,
          PostalCode: a.postal_code,
        }
      : undefined;

  const shipToAddresses = otherAddrs.map((a) => ({
    Name: a.id,
    Addr1: a.address_1 || undefined,
    Addr2: a.address_2 || undefined,
    City: a.city || undefined,
    State: a.province || undefined,
    PostalCode: a.postal_code || undefined,
  }));

  const qbListId = customer.metadata?.qb_list_id || "8000004E-1342117388";

  const payload = {
    action: "mod",
    ListID: qbListId,
    EditSequence: "12345",
    FirstName: customer.first_name || undefined,
    LastName: customer.last_name || undefined,
    CompanyName: customer.company_name || undefined,
    Email: customer.email,
    Phone: customer.phone || undefined,
    BillAddress: mapBillAddr(billingAddr),
    ShipToAddress: shipToAddresses.length > 0 ? shipToAddresses : undefined,
    CustomerType: customer.metadata?.qb_customer_type || undefined,
    PriceLevel: customer.metadata?.qb_price_level || undefined,
    AltContact: customer.metadata?.alt_contact || undefined,
    AltPhone: customer.metadata?.alt_phone || undefined,
  };

  console.log("--- PAYLOAD TO BRIDGE ---");
  console.log(JSON.stringify(payload, null, 2));

  console.log("--- GENERATED XML ---");
  console.log(buildCustomerMod(payload));
}

function escapeXml(str: any): string {
  if (!str) return "";
  return String(str)
    .replace(/[\u2013\u2014]/g, "-")
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201C\u201D]/g, '"')
    .replace(/\u2026/g, "...")
    .replace(/\u00A0/g, " ")
    .replace(/[^\x00-\x7F]/g, "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function buildCustomerMod(data: any): string {
  const name = data.Name || data.name;
  const firstName = data.FirstName || data.firstName;
  const lastName = data.LastName || data.lastName;
  const companyName = data.CompanyName || data.companyName;
  const email = data.Email || data.email;
  const phone = data.Phone || data.phone;
  const billAddress =
    data.BillAddress || data.BillingAddress || data.billingAddress;
  const customerType = data.CustomerType || data.customerType;
  const priceLevel = data.PriceLevel || data.priceLevel;
  const altContact = data.AltContact || data.altContact;
  const altPhone = data.AltPhone || data.altPhone;
  const shipToAddresses: any[] = Array.isArray(data.ShipToAddress)
    ? data.ShipToAddress
    : [];

  const buildShipTo = (addr: any): string =>
    `<ShipToAddress>` +
    `<Name>${escapeXml(addr.Name)}</Name>` +
    (addr.Addr1 ? `<Addr1>${escapeXml(addr.Addr1)}</Addr1>` : "") +
    (addr.Addr2 ? `<Addr2>${escapeXml(addr.Addr2)}</Addr2>` : "") +
    (addr.City ? `<City>${escapeXml(addr.City)}</City>` : "") +
    (addr.State ? `<State>${escapeXml(addr.State)}</State>` : "") +
    (addr.PostalCode
      ? `<PostalCode>${escapeXml(addr.PostalCode)}</PostalCode>`
      : "") +
    `</ShipToAddress>`;

  function buildAddress(address: any, tag: string): string {
    if (!address) return "";
    const addr1 = address.Addr1 || address.street;
    const city = address.City || address.city;
    const state = address.State || address.state;
    const zip = address.PostalCode || address.zip;
    if (!addr1 && !city && !state && !zip) return "";
    return (
      `<${tag}>` +
      (addr1 ? `<Addr1>${escapeXml(addr1)}</Addr1>` : "") +
      (city ? `<City>${escapeXml(city)}</City>` : "") +
      (state ? `<State>${escapeXml(state)}</State>` : "") +
      (zip ? `<PostalCode>${escapeXml(zip)}</PostalCode>` : "") +
      `</${tag}>`
    );
  }

  return (
    `<CustomerModRq><CustomerMod>` +
    `<ListID>${escapeXml(data.ListID)}</ListID>` +
    `<EditSequence>${escapeXml(data.EditSequence)}</EditSequence>` +
    (data.IsActive !== undefined
      ? `<IsActive>${data.IsActive}</IsActive>`
      : "") +
    (name ? `<Name>${escapeXml(name)}</Name>` : "") +
    (companyName
      ? `<CompanyName>${escapeXml(companyName)}</CompanyName>`
      : "") +
    (firstName ? `<FirstName>${escapeXml(firstName)}</FirstName>` : "") +
    (lastName ? `<LastName>${escapeXml(lastName)}</LastName>` : "") +
    buildAddress(billAddress, "BillAddress") +
    shipToAddresses.map(buildShipTo).join("") +
    (phone ? `<Phone>${escapeXml(phone)}</Phone>` : "") +
    (altPhone ? `<AltPhone>${escapeXml(altPhone)}</AltPhone>` : "") +
    (email ? `<Email>${escapeXml(email)}</Email>` : "") +
    (altContact ? `<AltContact>${escapeXml(altContact)}</AltContact>` : "") +
    (customerType
      ? `<CustomerTypeRef><FullName>${escapeXml(customerType)}</FullName></CustomerTypeRef>`
      : "") +
    (priceLevel
      ? `<PriceLevelRef><FullName>${escapeXml(priceLevel)}</FullName></PriceLevelRef>`
      : "") +
    `</CustomerMod></CustomerModRq>`
  );
}
