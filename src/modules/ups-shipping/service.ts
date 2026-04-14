import { AbstractFulfillmentProviderService } from "@medusajs/utils";
import axios from "axios";

type UPSOptions = {
  clientId: string;
  clientSecret: string;
  serviceCode: string;
  serviceName: string;
  shipperName: string;
  shipperAddressLine1: string;
  shipperCity: string;
  shipperState: string;
  shipperPostalCode: string;
  shipperCountry: string;
};

class UPSShippingService extends AbstractFulfillmentProviderService {
  static identifier = "ups-shipping";
  protected options_: UPSOptions;
  private accessToken: string | null = null;
  private tokenExpiry: number = 0;

  constructor(options: UPSOptions) {
    super();
    this.options_ = options;
  }

  /**
   * Get OAuth access token from UPS
   */
  private async getAccessToken(): Promise<string> {
    // Return cached token if still valid
    if (this.accessToken && Date.now() < this.tokenExpiry) {
      return this.accessToken;
    }

    const auth = Buffer.from(
      `${this.options_.clientId}:${this.options_.clientSecret}`
    ).toString("base64");

    try {
      const response = await axios.post(
        "https://onlinetools.ups.com/security/v1/oauth/token",
        "grant_type=client_credentials",
        {
          headers: {
            Authorization: `Basic ${auth}`,
            "Content-Type": "application/x-www-form-urlencoded",
          },
        }
      );

      this.accessToken = response.data.access_token;
      // Token expires in 3600 seconds, cache for 3500 to be safe
      this.tokenExpiry = Date.now() + 3500 * 1000;

      return this.accessToken!;
    } catch (error: any) {
      console.error("UPS OAuth error:", error.response?.data || error.message);
      throw new Error("Failed to authenticate with UPS API");
    }
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

  async canCalculate(data: any): Promise<boolean> {
    return Boolean(data.cart?.shipping_address);
  }

  async calculatePrice(
    _optionData: any,
    data: any,
    _context: any
  ): Promise<{
    calculated_amount: number;
    is_calculated_price_tax_inclusive: boolean;
  }> {
    const cart = data?.cart;

    // Enhanced logging for debugging
    console.log("\n🔵 UPS calculatePrice called:", {
      serviceCode: this.options_.serviceCode,
      serviceName: this.options_.serviceName,
      hasCart: !!cart,
      hasAddress: !!cart?.shipping_address,
      cartId: cart?.id,
      addressCity: cart?.shipping_address?.city,
    });

    // If no cart or address (e.g. Admin UI validation), return a dummy price to pass validation
    if (!cart?.shipping_address) {
      console.log(
        "⚠️  UPS: No cart/address, returning fallback price for validation"
      );
      return {
        calculated_amount: 2500,
        is_calculated_price_tax_inclusive: false,
      }; // Return $25.00 as placeholder
    }

    // Calculate total weight from cart items
    let totalWeight = 0;
    for (const item of cart.items || []) {
      const weight = item.variant?.weight || 1; // Default 1 lb if not set
      totalWeight += weight * item.quantity;
    }

    // Minimum weight for UPS is 0.1 lbs
    if (totalWeight < 0.1) {
      totalWeight = 0.1;
    }

    try {
      const token = await this.getAccessToken();

      const rateRequest = {
        RateRequest: {
          Request: {
            TransactionReference: {
              CustomerContext: "Rate Request",
            },
          },
          Shipment: {
            Shipper: {
              Name: this.options_.shipperName,
              ShipperNumber: "", // Not required for rating
              Address: {
                AddressLine: [this.options_.shipperAddressLine1],
                City: this.options_.shipperCity,
                StateProvinceCode: this.options_.shipperState,
                PostalCode: this.options_.shipperPostalCode,
                CountryCode: this.options_.shipperCountry,
              },
            },
            ShipTo: {
              Name:
                cart.shipping_address.company ||
                cart.shipping_address.first_name,
              Address: {
                AddressLine: [cart.shipping_address.address_1],
                City: cart.shipping_address.city,
                StateProvinceCode: cart.shipping_address.province,
                PostalCode: cart.shipping_address.postal_code,
                CountryCode: cart.shipping_address.country_code?.toUpperCase(),
              },
            },
            Service: {
              Code: this.options_.serviceCode,
              Description: this.options_.serviceName,
            },
            Package: [
              {
                PackagingType: {
                  Code: "02", // Customer Supplied Package
                  Description: "Package",
                },
                PackageWeight: {
                  UnitOfMeasurement: {
                    Code: "LBS",
                    Description: "Pounds",
                  },
                  Weight: totalWeight.toFixed(1),
                },
              },
            ],
          },
        },
      };

      const response = await axios.post(
        "https://onlinetools.ups.com/api/rating/v1/Rate",
        rateRequest,
        {
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
            transId: `rate_${Date.now()}`,
            transactionSrc: "medusa",
          },
          params: {
            additionalinfo: "validate",
          },
        }
      );

      const ratedShipment = response.data.RateResponse?.RatedShipment;
      if (!ratedShipment) {
        throw new Error("No rate returned from UPS");
      }

      // Try to get negotiated rate first, fallback to published rate
      const rateStr =
        ratedShipment.NegotiatedRateCharges?.TotalCharge?.MonetaryValue ||
        ratedShipment.TotalCharges?.MonetaryValue ||
        "0";

      const rate = parseFloat(rateStr);
      const priceInCents = Math.round(rate * 100);

      console.log("✅ UPS API SUCCESS:", {
        serviceCode: this.options_.serviceCode,
        serviceName: this.options_.serviceName,
        rateUSD: rate,
        priceInCents: priceInCents,
      });

      // Return price in cents
      return {
        calculated_amount: priceInCents,
        is_calculated_price_tax_inclusive: false,
      };
    } catch (error: any) {
      console.error("❌ UPS Rate API error:", {
        serviceCode: this.options_.serviceCode,
        error: error.response?.data || error.message,
      });

      // Fallback prices if API fails (in cents)
      const fallbackPrices: Record<string, number> = {
        "01": 5000, // Next Day Air: $50
        "02": 3500, // 2nd Day Air: $35
        "12": 2500, // 3 Day Select: $25
      };

      const fallbackPrice = fallbackPrices[this.options_.serviceCode] || 2500;
      console.log("⚠️  Using fallback price:", fallbackPrice, "cents");

      return {
        calculated_amount: fallbackPrice,
        is_calculated_price_tax_inclusive: false,
      };
    }
  }

  async createFulfillment(
    _data: any,
    _items: any,
    _order: any,
    _fulfillment: any
  ): Promise<any> {
    // TODO: Implement shipping label generation
    return {
      data: {
        method: `ups-${this.options_.serviceCode}`,
        service: this.options_.serviceName,
        tracking_number: "",
      },
    };
  }

  async cancelFulfillment(_fulfillment: any): Promise<any> {
    // TODO: Implement shipment cancellation if needed
    return {};
  }

  async getFulfillmentOptions(): Promise<any[]> {
    return [
      {
        id: `ups-${this.options_.serviceCode}`,
        name: this.options_.serviceName,
      },
    ];
  }

  async retrieveDocuments(
    _fulfillmentData: any,
    _documentType: string
  ): Promise<any> {
    return null;
  }
}

export default UPSShippingService;
