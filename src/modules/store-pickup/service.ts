import { AbstractFulfillmentProviderService } from "@medusajs/utils";

class StorePickupService extends AbstractFulfillmentProviderService {
  static identifier = "store-pickup";

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
    _data: any,
    _context: any
  ): Promise<{
    calculated_amount: number;
    is_calculated_price_tax_inclusive: boolean;
  }> {
    // Store pickup is always free
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
        method: "store-pickup",
        instructions: "Customer will pick up order at store location",
      },
    };
  }

  async cancelFulfillment(_fulfillment: any): Promise<any> {
    return {};
  }

  async getFulfillmentOptions(): Promise<any[]> {
    return [
      {
        id: "store-pickup",
        name: "Store Pickup",
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

export default StorePickupService;
