import { defineRouteConfig } from "@medusajs/admin-sdk";
import { BuildingStorefront } from "@medusajs/icons";
import { Heading, Text } from "@medusajs/ui";
import { BankAccountsCard } from "./components/BankAccountsCard";
import { SequenceManagerCard } from "./components/SequenceManagerCard";

const AccountingPage = () => {
  return (
    <div className="flex flex-col gap-4 p-6 max-w-5xl">
      <div>
        <Heading level="h1">Accounting & QuickBooks Ops</Heading>
        <Text className="text-ui-fg-subtle mt-1">
          Manage pending refunds, map bank accounts, internal sequence cursors,
          and orchestrate synchronization.
        </Text>
      </div>

      <SequenceManagerCard />
      <BankAccountsCard />
    </div>
  );
};

export const config = defineRouteConfig({
  label: "Accounting",
  icon: BuildingStorefront,
});

export default AccountingPage;
