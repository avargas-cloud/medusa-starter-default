export interface VendorDisplayNameFields {
  id?: string | null;
  company_name?: string | null;
  full_name?: string | null;
  name?: string | null;
}

function nonBlank(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

/**
 * Canonical staff-facing vendor label.
 *
 * QuickBooks keeps CompanyName, FullName, and Name as distinct fields. Document
 * routes must use one shared priority so the same vendor never looks duplicated.
 */
export function resolveVendorDisplayName(
  vendor: VendorDisplayNameFields,
  fallback: string | null = null
): string | null {
  return (
    nonBlank(vendor.company_name) ??
    nonBlank(vendor.full_name) ??
    nonBlank(vendor.name) ??
    nonBlank(vendor.id) ??
    nonBlank(fallback)
  );
}
