import { ArrowLeft } from "@medusajs/icons";
import { Badge, Button, Container, Heading, Text, toast } from "@medusajs/ui";
import { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";

type QbVendor = {
  id: string;
  qb_list_id: string;
  full_name: string;
  name: string;
  company_name: string | null;
  account_number: string | null;
  is_active: boolean;
  first_name: string | null;
  middle_initial: string | null;
  last_name: string | null;
  contact: string | null;
  alt_contact: string | null;
  email: string | null;
  phone: string | null;
  alt_phone: string | null;
  fax: string | null;
  addr1: string | null;
  addr2: string | null;
  city: string | null;
  state: string | null;
  postal_code: string | null;
  country: string | null;
  terms_ref_name: string | null;
  prefill_account_ref_name: string | null;
  vendor_type_ref_name: string | null;
  currency_ref_name: string | null;
  tax_identity: string | null;
  is_vendor_eligible_for_1099: boolean | null;
  credit_limit: string | number | null;
  notes: string | null;
  last_synced_at: string | null;
  created_at: string | null;
  updated_at: string | null;
};

const Field = ({
  label,
  value,
  mono,
}: {
  label: string;
  value: React.ReactNode;
  mono?: boolean;
}) => {
  const display = value == null || value === "" ? "—" : value;
  const isDash = display === "—";
  return (
    <div className="flex flex-col gap-1">
      <Text size="xsmall" className="text-ui-fg-muted uppercase tracking-wide">
        {label}
      </Text>
      <Text
        className={`${isDash ? "text-ui-fg-muted" : "text-ui-fg-base"} ${mono ? "font-mono text-sm" : ""}`}
      >
        {display}
      </Text>
    </div>
  );
};

const Section = ({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) => (
  <Container className="p-0">
    <div className="px-6 py-4 border-b border-ui-border-base">
      <Heading level="h2">{title}</Heading>
    </div>
    <div className="grid grid-cols-1 md:grid-cols-3 gap-6 px-6 py-5">
      {children}
    </div>
  </Container>
);

const VendorDetailPage = () => {
  const navigate = useNavigate();
  const { id } = useParams();
  const [vendor, setVendor] = useState<QbVendor | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const load = async () => {
      setLoading(true);
      try {
        const res = await fetch(`/admin/qb-catalog/vendors/${id}`, {
          credentials: "include",
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        setVendor(data.vendor);
      } catch (e) {
        toast.error("Failed to load vendor", {
          description: (e as Error).message,
        });
      } finally {
        setLoading(false);
      }
    };
    if (id) load();
  }, [id]);

  if (loading) {
    return (
      <div className="p-6">
        <Text className="text-ui-fg-subtle">Loading vendor…</Text>
      </div>
    );
  }
  if (!vendor) {
    return (
      <div className="p-6">
        <Text className="text-ui-fg-subtle">Vendor not found.</Text>
        <Button
          variant="transparent"
          className="mt-3"
          onClick={() => navigate("/vendors")}
        >
          <ArrowLeft /> Back to vendors
        </Button>
      </div>
    );
  }

  const fullContactName =
    [vendor.first_name, vendor.middle_initial, vendor.last_name]
      .filter(Boolean)
      .join(" ")
      .trim() || null;

  const addressLines = [
    vendor.addr1,
    vendor.addr2,
    [vendor.city, vendor.state, vendor.postal_code].filter(Boolean).join(", "),
    vendor.country,
  ].filter(Boolean);

  const formatDate = (iso: string | null) =>
    iso ? new Date(iso).toLocaleString() : "—";

  return (
    <div className="flex flex-col gap-4 p-6">
      <Button
        variant="transparent"
        onClick={() => navigate("/vendors")}
        className="self-start -ml-2"
      >
        <ArrowLeft /> Back to vendors
      </Button>

      <Container className="p-0">
        <div className="flex items-start justify-between px-6 py-5 border-b border-ui-border-base">
          <div className="flex flex-col gap-1">
            <div className="flex items-center gap-3">
              <Heading level="h1">{vendor.full_name}</Heading>
              {vendor.is_active ? (
                <Badge color="green" size="small">
                  Active
                </Badge>
              ) : (
                <Badge color="grey" size="small">
                  Inactive
                </Badge>
              )}
            </div>
            {vendor.company_name && (
              <Text className="text-ui-fg-subtle">{vendor.company_name}</Text>
            )}
          </div>
          <div className="flex flex-col gap-1 text-right">
            <Text size="xsmall" className="text-ui-fg-muted">
              QB List ID
            </Text>
            <code className="text-xs text-ui-fg-subtle">
              {vendor.qb_list_id}
            </code>
          </div>
        </div>
      </Container>

      <Section title="Contact">
        <Field label="Full contact name" value={fullContactName} />
        <Field label="First name" value={vendor.first_name} />
        <Field label="Last name" value={vendor.last_name} />
        <Field label="Middle initial" value={vendor.middle_initial} />
        <Field label="Contact (QB legacy)" value={vendor.contact} />
        <Field label="Alt contact" value={vendor.alt_contact} />
        <Field
          label="Email"
          value={
            vendor.email ? (
              <a
                href={`mailto:${vendor.email}`}
                className="text-ui-fg-interactive hover:underline"
              >
                {vendor.email}
              </a>
            ) : null
          }
        />
        <Field
          label="Phone"
          value={
            vendor.phone ? (
              <a
                href={`tel:${vendor.phone}`}
                className="text-ui-fg-interactive hover:underline"
              >
                {vendor.phone}
              </a>
            ) : null
          }
        />
        <Field label="Alt phone" value={vendor.alt_phone} />
        <Field label="Fax" value={vendor.fax} />
      </Section>

      <Section title="Address">
        <Field label="Address line 1" value={vendor.addr1} />
        <Field label="Address line 2" value={vendor.addr2} />
        <Field label="City" value={vendor.city} />
        <Field label="State" value={vendor.state} />
        <Field label="Postal code" value={vendor.postal_code} />
        <Field label="Country" value={vendor.country} />
        {addressLines.length > 0 && (
          <div className="md:col-span-3 pt-2 border-t border-ui-border-base">
            <Text size="xsmall" className="text-ui-fg-muted uppercase mb-1">
              Formatted
            </Text>
            <Text className="whitespace-pre-line">
              {addressLines.join("\n")}
            </Text>
          </div>
        )}
      </Section>

      <Section title="Purchase Order Defaults">
        <Field label="Terms" value={vendor.terms_ref_name} />
        <Field
          label="Prefill account"
          value={vendor.prefill_account_ref_name}
          mono
        />
        <Field label="Vendor type" value={vendor.vendor_type_ref_name} />
        <Field label="Currency" value={vendor.currency_ref_name} />
        <Field label="Account number" value={vendor.account_number} />
      </Section>

      <Section title="Tax & Financial">
        <Field label="Tax ID / EIN" value={vendor.tax_identity} mono />
        <Field
          label="1099 eligible"
          value={
            vendor.is_vendor_eligible_for_1099 === true
              ? "Yes"
              : vendor.is_vendor_eligible_for_1099 === false
                ? "No"
                : null
          }
        />
        <Field
          label="Credit limit"
          value={
            vendor.credit_limit != null
              ? `$${Number(vendor.credit_limit).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
              : null
          }
        />
      </Section>

      {vendor.notes && (
        <Container className="p-0">
          <div className="px-6 py-4 border-b border-ui-border-base">
            <Heading level="h2">Notes</Heading>
          </div>
          <div className="px-6 py-5">
            <Text className="whitespace-pre-line">{vendor.notes}</Text>
          </div>
        </Container>
      )}

      <Container className="p-0">
        <div className="px-6 py-4 border-b border-ui-border-base">
          <Heading level="h2">Metadata</Heading>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-6 px-6 py-5">
          <Field label="Internal ID" value={vendor.id} mono />
          <Field
            label="Last synced"
            value={formatDate(vendor.last_synced_at)}
          />
          <Field label="Updated" value={formatDate(vendor.updated_at)} />
        </div>
      </Container>
    </div>
  );
};

export default VendorDetailPage;
