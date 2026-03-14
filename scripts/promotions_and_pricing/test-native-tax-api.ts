import 'dotenv/config';

async function run() {
  const MEDUSA_URL = process.env.MEDUSA_BACKEND_URL || "http://localhost:9000"
  let cartId = "cart_01KK1TMASVPMNMPNDKZFMXJ6WM"
  
  try {
    const pubKey = process.env.PUBLISHABLE_API_KEY || "pk_519e7f66680afc4ab0136ce701a7f6d1e8df2b8fc48a29b7a55616a05cb5b5f3"
    
    // First, complete fetching the cart without modifications to see its current state
    const res = await fetch(`${MEDUSA_URL}/store/carts/${cartId}`, {
      headers: { "x-publishable-api-key": pubKey }
    });
    const cartData = await res.json()
    const cart = cartData.cart || cartData;
    
    console.log("Cart Tax Total:", cart.tax_total)
    console.log("Cart Total:", cart.total)
    console.log("Cart Shipping Total:", cart.shipping_total)
  } catch (err) {
    console.error(err);
  }
}

run();
