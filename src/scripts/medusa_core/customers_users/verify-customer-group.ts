import { ExecArgs } from "@medusajs/framework/types";
import { Modules } from "@medusajs/utils";

/**
 * Verify customer group assignment in database
 * Run with: npx medusa exec ./src/scripts/verify-customer-group.ts
 */
export default async function verifyCustomerGroup({ container }: ExecArgs) {
  const logger = container.resolve("logger");
  const customerModule = container.resolve(Modules.CUSTOMER);

  const customerEmail = "a.vargas@ecopowertech.com";

  logger.info(`Checking customer: ${customerEmail}`);

  try {
    // Find customer
    const customers = await customerModule.listCustomers(
      {
        email: customerEmail,
      },
      {
        relations: ["groups"],
      }
    );

    if (customers.length === 0) {
      logger.error(`❌ Customer not found: ${customerEmail}`);
      return;
    }

    const customer = customers[0];

    logger.info(`\n✅ Customer found: ${customer.id}`);
    logger.info(`   Name: ${customer.first_name} ${customer.last_name}`);
    logger.info(`   Email: ${customer.email}`);
    logger.info(`   Groups: ${customer.groups?.length || 0}`);

    if (customer.groups && customer.groups.length > 0) {
      logger.info(`\n📋 Customer Groups:`);
      customer.groups.forEach((group) => {
        logger.info(`   - ${group.name} (${group.id})`);
      });
    } else {
      logger.warn(`\n⚠️  Customer has NO groups assigned!`);
      logger.warn(`   This means they will get RETAIL pricing`);
    }

    // Check if Wholesale group exists
    const wholesaleGroups = await customerModule.listCustomerGroups({
      name: "Wholesale",
    });

    if (wholesaleGroups.length > 0) {
      const wholesaleGroup = wholesaleGroups[0];
      logger.info(`\n✅ Wholesale group exists: ${wholesaleGroup.id}`);

      const isWholesale = customer.groups?.some(
        (g) => g.id === wholesaleGroup.id
      );
      if (isWholesale) {
        logger.info(`   ✅ Customer IS in Wholesale group`);
      } else {
        logger.error(`   ❌ Customer is NOT in Wholesale group!`);
        logger.error(`   
                Fix in Medusa Admin:
                1. Go to Customers
                2. Find ${customerEmail}
                3. Add to "Wholesale" group
                4. Save
                `);
      }
    }
  } catch (error: any) {
    logger.error(`❌ Error: ${error.message}`);
  }
}
