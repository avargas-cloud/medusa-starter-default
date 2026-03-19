import 'dotenv/config';
import { initialize } from "@medusajs/utils";
import { calculateCartTaxesWorkflow } from '@medusajs/medusa/core-flows';

async function run() {
  const { container } = await initialize({ configModule: require('../../../medusa-config').default });
  
  // Try to force a re-calculation on the cart natively via workflow
  const cartId = "cart_01KK1TMASVPMNMPNDKZFMXJ6WM"
  try {
     const result = await calculateCartTaxesWorkflow(container).run({
        input: { cart_id: cartId }
     });
     console.log("RESULT", result);
  } catch(e) { console.error(e) }
  process.exit(0);
}
run();
