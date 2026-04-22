/**
 * Address formatting utilities — mirror of store-pos/lib/format-address.ts.
 * Apply at save time on the backend and in backfill scripts so legacy rows
 * converge to the canonical shape.
 */

const ABBREV = new Set<string>([
  // Directionals
  "N",
  "S",
  "E",
  "W",
  "NE",
  "NW",
  "SE",
  "SW",
  // Street types
  "ST",
  "AVE",
  "AV",
  "RD",
  "DR",
  "BLVD",
  "LN",
  "CT",
  "PL",
  "WAY",
  "HWY",
  "PKWY",
  "CIR",
  "TRL",
  "TER",
  "SQ",
  "PLZ",
  "LOOP",
  "ROW",
  "XING",
  "BND",
  "RUN",
  "WALK",
  "PATH",
  "EXPY",
  "FWY",
  "TPKE",
  // Unit types
  "APT",
  "UNIT",
  "STE",
  "FL",
  "BLDG",
  "PO",
  "PMB",
  "RM",
  "DEPT",
  // US state codes + DC + territories
  "AL",
  "AK",
  "AZ",
  "AR",
  "CA",
  "CO",
  "CT",
  "DE",
  "FL",
  "GA",
  "HI",
  "ID",
  "IL",
  "IN",
  "IA",
  "KS",
  "KY",
  "LA",
  "ME",
  "MD",
  "MA",
  "MI",
  "MN",
  "MS",
  "MO",
  "MT",
  "NE",
  "NV",
  "NH",
  "NJ",
  "NM",
  "NY",
  "NC",
  "ND",
  "OH",
  "OK",
  "OR",
  "PA",
  "RI",
  "SC",
  "SD",
  "TN",
  "TX",
  "UT",
  "VT",
  "VA",
  "WA",
  "WV",
  "WI",
  "WY",
  "DC",
  "PR",
  "VI",
  "GU",
  "AS",
  "MP",
  "USA",
  "US",
]);

const PUNCT = /^([.,;:#-]*)(.*?)([.,;:#-]*)$/;

export function formatAddressLine(input?: string | null): string {
  if (!input) return "";
  const parts = input.split(/(\s+)/);
  return parts
    .map((token) => {
      if (token === "" || /^\s+$/.test(token)) return token;
      const match = token.match(PUNCT);
      if (!match) return token;
      const [, leading, core, trailing] = match;
      if (!core) return token;
      if (/\d/.test(core)) return leading + core + trailing;
      // Strip internal dots so "S.W." still matches SW.
      const dotStripped = core.replace(/\./g, "").toUpperCase();
      if (ABBREV.has(dotStripped)) return leading + core.toUpperCase() + trailing;
      const titled = core
        .split(/(['-])/)
        .map((p) =>
          p === "'" || p === "-"
            ? p
            : p.charAt(0).toUpperCase() + p.slice(1).toLowerCase()
        )
        .join("");
      return leading + titled + trailing;
    })
    .join("");
}

type AddressLike = {
  address_1?: string | null;
  address_2?: string | null;
  city?: string | null;
  province?: string | null;
  postal_code?: string | null;
  country_code?: string | null;
};

export function sanitizeAddress<T extends AddressLike>(addr: T): T {
  return {
    ...addr,
    address_1: formatAddressLine(addr.address_1 ?? ""),
    address_2: formatAddressLine(addr.address_2 ?? ""),
    city: formatAddressLine(addr.city ?? ""),
    province: addr.province ? addr.province.toUpperCase() : addr.province,
  };
}
