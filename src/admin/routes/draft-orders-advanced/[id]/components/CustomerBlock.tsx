import { EllipsisHorizontal, PencilSquare, ArrowRight } from "@medusajs/icons";
import { Container, Heading, Text, Button, DropdownMenu } from "@medusajs/ui";

interface Props {
  customer: any;
  customerName: string;
  shippingLines: string[];
  billingLines: string[];
  onOpenModal: (modal: string) => void;
}

export const CustomerBlock = ({
  customer,
  customerName,
  shippingLines,
  billingLines,
  onOpenModal,
}: Props) => (
  <Container className="p-0 overflow-hidden">
    <div className="flex items-center justify-between px-6 py-4 border-b border-ui-border-base">
      <Heading level="h2">Customer</Heading>
      <DropdownMenu>
        <DropdownMenu.Trigger asChild>
          <Button variant="transparent" size="small">
            <EllipsisHorizontal />
          </Button>
        </DropdownMenu.Trigger>
        <DropdownMenu.Content>
          <DropdownMenu.Item
            className="gap-x-2"
            onClick={() => onOpenModal("transfer")}
          >
            <ArrowRight className="text-ui-fg-subtle" /> Transfer ownership
          </DropdownMenu.Item>
          <DropdownMenu.Separator />
          <DropdownMenu.Item
            className="gap-x-2"
            onClick={() => onOpenModal("shipping-addr")}
          >
            <PencilSquare className="text-ui-fg-subtle" /> Edit shipping address
          </DropdownMenu.Item>
          <DropdownMenu.Item
            className="gap-x-2"
            onClick={() => onOpenModal("billing-addr")}
          >
            <PencilSquare className="text-ui-fg-subtle" /> Edit billing address
          </DropdownMenu.Item>
          <DropdownMenu.Item
            className="gap-x-2"
            onClick={() => onOpenModal("email")}
          >
            <PencilSquare className="text-ui-fg-subtle" /> Edit email
          </DropdownMenu.Item>
        </DropdownMenu.Content>
      </DropdownMenu>
    </div>
    <div className="grid grid-cols-3 gap-6 px-6 py-4">
      <div className="space-y-1">
        <Text
          size="xsmall"
          weight="plus"
          className="text-ui-fg-muted uppercase tracking-wider mb-2"
        >
          Contact
        </Text>
        {customer?.company_name && (
          <Text size="small" weight="plus">
            {customer.company_name}
          </Text>
        )}
        <Text
          size="small"
          className={customer?.company_name ? "text-ui-fg-subtle" : ""}
        >
          {customerName}
        </Text>
        {customer?.email && (
          <Text size="small" className="text-ui-fg-subtle">
            {customer.email}
          </Text>
        )}
        {customer?.phone && (
          <Text size="small" className="text-ui-fg-subtle">
            {customer.phone}
          </Text>
        )}
      </div>
      <div className="space-y-1">
        <Text
          size="xsmall"
          weight="plus"
          className="text-ui-fg-muted uppercase tracking-wider mb-2"
        >
          Shipping Address
        </Text>
        {shippingLines.length > 0 ? (
          shippingLines.map((l, i) => (
            <Text key={i} size="small" className="text-ui-fg-subtle">
              {l}
            </Text>
          ))
        ) : (
          <Text size="small" className="text-ui-fg-muted">
            —
          </Text>
        )}
      </div>
      <div className="space-y-1">
        <Text
          size="xsmall"
          weight="plus"
          className="text-ui-fg-muted uppercase tracking-wider mb-2"
        >
          Billing Address
        </Text>
        {billingLines.length > 0 ? (
          billingLines.map((l, i) => (
            <Text key={i} size="small" className="text-ui-fg-subtle">
              {l}
            </Text>
          ))
        ) : (
          <Text size="small" className="text-ui-fg-muted">
            Same as shipping
          </Text>
        )}
      </div>
    </div>
  </Container>
);
