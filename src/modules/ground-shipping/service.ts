import { AbstractFulfillmentProviderService } from "@medusajs/utils";
import Knex from "knex";

/**
 * Ground Shipping Service
 *
 * When override_ups_ground = true (default): uses custom flat-rate pricing
 *   - Free if cart total >= free_shipping_minimum
 *   - Long item rate if cart has long-profile items
 *   - Regular flat rate otherwise
 *
 * When override_ups_ground = false: delegates to UPS Ground real-time rate
 *   (handled externally — this service just returns 0 and UPS Ground option shows separately)
 */

interface GroundShippingDeps {
  __pg_connection__: Knex.Knex;
}

class GroundShippingService extends AbstractFulfillmentProviderService {
  static identifier = "ground-shipping";

  private knex: Knex.Knex;

  constructor({ __pg_connection__ }: GroundShippingDeps) {
    super();
    this.knex = __pg_connection__;
  }

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
    const cart = data?.cart || (context?.id ? context : null);

    if (!cart) {
      console.log("❌ Ground Shipping: no cart found");
      throw new Error("Ground Shipping: no cart available");
    }

    // Fetch settings directly via knex (container not available in fulfillment provider context)
    const [settings] = await this.knex("shipping_settings")
      .select(
        "free_shipping_minimum",
        "regular_ground_shipping_price",
        "long_item_ground_shipping_price",
        "override_ups_ground"
      )
      .limit(1);

    console.log(`🔍 Ground Shipping settings: ${JSON.stringify(settings)}`);

    if (!settings || !settings.override_ups_ground) {
      // override disabled — UPS Ground option handles this separately
      console.log(
        "Ground Shipping: override disabled, throwing to hide option"
      );
      throw new Error("Ground Shipping: override disabled");
    }

    // In calculatePrice context, unit_price is in DOLLARS (e.g. 0.85 for $0.85)
    // Multiply by 100 to compare against DB cents thresholds (free_shipping_minimum is stored in cents)
    const itemsTotal = Math.round(
      (cart.items || []).reduce((sum: number, item: any) => {
        return sum + item.unit_price * (item.quantity || 1);
      }, 0) * 100
    );
    const cartTotal = itemsTotal || 0;
    const freeMinCents = settings.free_shipping_minimum; // stored in cents in DB
    // Extract product IDs from cart items
    // Medusa does NOT populate shipping_profile in calculatePrice context → query DB directly
    const productIds = (cart.items || [])
      .map((item: any) => {
        const pid =
          item.variant?.product_id ||
          item.product_id ||
          item.variant?.product?.id;
        return pid;
      })
      .filter(Boolean);

    // Detect long items by dimensions (> 30") — same criterion as box-packing.ts
    // Reads from inventory_item first (where the widget saves), then product_variant fallback.
    let hasLongItems = false;
    if (productIds.length > 0) {
      try {
        const LONG_ITEM_THRESHOLD_INCHES = 30;
        // Check inventory_item dimensions first (primary source via widget)
        const longViaInventory = await this.knex("product_variant as pv")
          .join(
            "product_variant_inventory_item as pvii",
            "pvii.variant_id",
            "pv.id"
          )
          .join("inventory_item as ii", "ii.id", "pvii.inventory_item_id")
          .whereIn("pv.product_id", productIds)
          .where(function () {
            this.where("ii.length", ">", LONG_ITEM_THRESHOLD_INCHES)
              .orWhere("ii.width", ">", LONG_ITEM_THRESHOLD_INCHES)
              .orWhere("ii.height", ">", LONG_ITEM_THRESHOLD_INCHES);
          })
          .select("pv.id", "pv.sku");

        if (longViaInventory.length > 0) {
          hasLongItems = true;
          console.log(
            `📏 Ground Shipping: long item (inventory_item) — ${longViaInventory.map((v: any) => v.sku).join(", ")}`
          );
        } else {
          // Fallback: check product_variant dimensions directly
          const longViaVariant = await this.knex("product_variant")
            .whereIn("product_id", productIds)
            .where(function () {
              this.where("length", ">", LONG_ITEM_THRESHOLD_INCHES)
                .orWhere("width", ">", LONG_ITEM_THRESHOLD_INCHES)
                .orWhere("height", ">", LONG_ITEM_THRESHOLD_INCHES);
            })
            .select("id", "sku");

          hasLongItems = longViaVariant.length > 0;
          if (hasLongItems) {
            console.log(
              `📏 Ground Shipping: long item (variant) — ${longViaVariant.map((v: any) => v.sku).join(", ")}`
            );
          }
        }
      } catch (dbErr) {
        console.error(
          `❌ Ground Shipping: DB query for long items failed:`,
          dbErr
        );
        hasLongItems = false;
      }
    }

    console.log(
      `🟢 Ground Shipping: cartTotal=${cartTotal}¢, freeMin=${freeMinCents}¢, hasLongItems=${hasLongItems}`
    );

    // 1. Free shipping if cart total >= threshold
    if (cartTotal >= freeMinCents) {
      console.log("✅ Ground Shipping: FREE");
      return { calculated_amount: 0, is_calculated_price_tax_inclusive: false };
    }

    // 2. Long item rate
    // DB value is in cents → divide by 100 to return dollars (calculatePrice contract)
    if (hasLongItems) {
      const priceCents = settings.long_item_ground_shipping_price;
      const priceDollars = priceCents / 100;
      console.log(`📦 Ground Shipping: LONG ITEM $${priceDollars.toFixed(2)}`);
      return {
        calculated_amount: priceDollars,
        is_calculated_price_tax_inclusive: false,
      };
    }

    // 3. Regular flat rate
    // DB value is in cents → divide by 100 to return dollars (calculatePrice contract)
    const priceCents = settings.regular_ground_shipping_price;
    const priceDollars = priceCents / 100;
    console.log(`🚢 Ground Shipping: REGULAR $${priceDollars.toFixed(2)}`);
    return {
      calculated_amount: priceDollars,
      is_calculated_price_tax_inclusive: false,
    };
  }

  async createFulfillment(
    _data: any,
    _items: any,
    _order: any,
    _fulfillment: any
  ): Promise<any> {
    return { data: { method: "ground-shipping" } };
  }

  async cancelFulfillment(_fulfillment: any): Promise<any> {
    return {};
  }

  async getFulfillmentOptions(): Promise<any[]> {
    return [{ id: "ground-shipping", name: "Ground Shipping" }];
  }

  async retrieveDocuments(
    _fulfillmentData: any,
    _documentType: string
  ): Promise<any> {
    return null;
  }
}

export default GroundShippingService;
