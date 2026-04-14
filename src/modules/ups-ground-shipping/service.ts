import { AbstractFulfillmentProviderService } from "@medusajs/utils";

import { packItems } from "../box-packing";
import { getUPSRate } from "../ups-rate-cache";

// UPS Service Code: 03 = Ground
const SERVICE_CODE = "03";
const SERVICE_NAME = "UPS Ground";

class UPSGroundShippingService extends AbstractFulfillmentProviderService {
  static identifier = "ups-ground";

  async validateOption(_data: any): Promise<boolean> {
    return true;
  }

  async validateFulfillmentData(
    _optionData: any,
    data: any,
    _context: any
  ): Promise<any> {
    return data;
  }

  async canCalculate(_data: any): Promise<boolean> {
    return true;
  }

  async calculatePrice(
    _optionData: any,
    data: any,
    context: any
  ): Promise<{
    calculated_amount: number;
    is_calculated_price_tax_inclusive: boolean;
  }> {
    const cart = context?.id ? context : data?.cart;

    console.log(`[UPS Ground] calculatePrice invoked.`);
    console.log(`[UPS Ground] context keys:`, Object.keys(context || {}));
    console.log(`[UPS Ground] data keys:`, Object.keys(data || {}));
    if (cart) {
      console.log(`[UPS Ground] cart structure:`, Object.keys(cart || {}));
      console.log(`[UPS Ground] shipping_address:`, cart.shipping_address);
    } else {
      console.log(`[UPS Ground] cart is completely null or undefined in args!`);
    }

    if (!cart?.shipping_address?.postal_code) {
      // No postal code yet — cart is in early state, silently skip
      return { calculated_amount: 0, is_calculated_price_tax_inclusive: false };
    }

    // ── Extract dimensions from inventory items (synced from product) ─────
    const rawItems = (cart.items || []).map((item: any) => {
      const inv = item.variant?.inventory_items?.[0]?.inventory_item;
      return {
        weight: parseFloat(inv?.weight ?? item.variant?.weight ?? 1),
        length: parseFloat(inv?.length ?? item.variant?.length ?? 1),
        width: parseFloat(inv?.width ?? item.variant?.width ?? 1),
        height: parseFloat(inv?.height ?? item.variant?.height ?? 1),
        quantity: item.quantity || 1,
      };
    });

    // ── Box packing: determine optimal package(s) ─────────────────────────
    const packages = packItems(rawItems);

    const fromLocation = context?.from_location;
    const fromAddress = fromLocation?.address;

    try {
      const price = await getUPSRate(SERVICE_CODE, {
        cartId: cart.id,
        postalCode: cart.shipping_address.postal_code,
        packages,
        shipperName: fromLocation?.name || process.env.UPS_ORIGIN_NAME || "",
        shipperAddress:
          fromAddress?.address_1 || process.env.UPS_ORIGIN_ADDRESS || "",
        shipperCity: fromAddress?.city || process.env.UPS_ORIGIN_CITY || "",
        shipperState:
          fromAddress?.province || process.env.UPS_ORIGIN_STATE || "",
        shipperZip:
          fromAddress?.postal_code || process.env.UPS_ORIGIN_ZIP || "",
        shipperCountry:
          fromAddress?.country_code?.toUpperCase() ||
          process.env.UPS_ORIGIN_COUNTRY ||
          "US",
        shipToName:
          cart.shipping_address.company ||
          cart.shipping_address.first_name ||
          "",
        shipToAddress: cart.shipping_address.address_1 || "",
        shipToCity: cart.shipping_address.city || "",
        shipToState: cart.shipping_address.province || "",
        shipToCountry:
          cart.shipping_address.country_code?.toUpperCase() || "US",
      });

      if (price !== null) {
        // getUPSRate returns cents → divide by 100 for the dollars that calculatePrice requires
        const priceDollars = price / 100;
        console.log(`✅ ${SERVICE_NAME}: $${priceDollars.toFixed(2)}`);
        return {
          calculated_amount: priceDollars,
          is_calculated_price_tax_inclusive: false,
        };
      }
    } catch (err: any) {
      console.error(`❌ ${SERVICE_NAME} rate error:`, err.message);
    }

    // Rate unavailable — return 0 so Medusa hides this option gracefully
    return { calculated_amount: 0, is_calculated_price_tax_inclusive: false };
  }

  async createFulfillment(
    _data: any,
    _items: any,
    _order: any,
    _fulfillment: any
  ): Promise<any> {
    return {
      data: {
        method: `ups-${SERVICE_CODE}`,
        service: SERVICE_NAME,
        tracking_number: "",
      },
    };
  }

  async cancelFulfillment(_fulfillment: any): Promise<any> {
    return {};
  }

  async getFulfillmentOptions(): Promise<any[]> {
    return [{ id: `ups-ground`, name: SERVICE_NAME }];
  }

  async retrieveDocuments(
    _fulfillmentData: any,
    _documentType: string
  ): Promise<any> {
    return null;
  }
}

export default UPSGroundShippingService;
