import type { AddrForm } from "./types";

export const fmt = (v: number, c: string) =>
  new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: c.toUpperCase(),
  }).format(v);

export const fmtDate = (d: string) =>
  new Date(d).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });

export const fmtRel = (d: string): string => {
  const s = (Date.now() - new Date(d).getTime()) / 1000;
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  if (s < 604800) return `${Math.floor(s / 86400)}d ago`;
  return new Date(d).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
  });
};

export const addrToLines = (
  a: Partial<AddrForm> | undefined,
  fallbackCompany?: string
): string[] =>
  !a
    ? []
    : ([
        `${a.first_name ?? ""} ${a.last_name ?? ""}`.trim(),
        a.company || fallbackCompany,
        a.address_1,
        a.address_2,
        `${a.city ?? ""} ${a.province ?? ""} ${a.postal_code ?? ""}`.trim(),
        a.country_code?.toUpperCase(),
        a.phone,
      ].filter(Boolean) as string[]);
