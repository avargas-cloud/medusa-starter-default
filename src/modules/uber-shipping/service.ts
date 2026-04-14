import {
  CalculatedShippingOptionPrice,
  CalculateShippingOptionPriceDTO,
  CreateFulfillmentResult,
  CreateShippingOptionDTO,
  FulfillmentDTO,
  FulfillmentItemDTO,
  FulfillmentOption,
  FulfillmentOrderDTO,
  ValidateFulfillmentDataContext,
} from "@medusajs/types";
import { AbstractFulfillmentProviderService } from "@medusajs/utils";

class UberShippingService extends AbstractFulfillmentProviderService {
  static identifier = "uber-shipping";

  async validateOption(_data: Record<string, unknown>): Promise<boolean> {
    return true;
  }

  async validateFulfillmentData(
    _optionData: Record<string, unknown>,
    data: Record<string, unknown>,
    _context: ValidateFulfillmentDataContext
  ): Promise<Record<string, unknown>> {
    return data;
  }

  async canCalculate(_data: CreateShippingOptionDTO): Promise<boolean> {
    return false;
  }

  async calculatePrice(
    _optionData: CalculateShippingOptionPriceDTO["optionData"],
    _data: CalculateShippingOptionPriceDTO["data"],
    _context: CalculateShippingOptionPriceDTO["context"]
  ): Promise<CalculatedShippingOptionPrice> {
    // Price is set manually on the shipping option — not calculated here
    return { calculated_amount: 0, is_calculated_price_tax_inclusive: false };
  }

  async createFulfillment(
    _data: Record<string, unknown>,
    _items: Partial<Omit<FulfillmentItemDTO, "fulfillment">>[],
    _order: Partial<FulfillmentOrderDTO> | undefined,
    _fulfillment: Partial<
      Omit<FulfillmentDTO, "provider_id" | "data" | "items">
    >
  ): Promise<CreateFulfillmentResult> {
    return {
      data: {
        method: "uber-shipping",
        instructions: "Delivery via Uber courier",
      },
      labels: [],
    };
  }

  async cancelFulfillment(
    _fulfillment: Record<string, unknown>
  ): Promise<Record<string, unknown>> {
    return {};
  }

  async getFulfillmentOptions(): Promise<FulfillmentOption[]> {
    return [
      {
        id: "uber-shipping",
        name: "Uber",
      },
    ];
  }

  async retrieveDocuments(
    _fulfillmentData: Record<string, unknown>,
    _documentType: string
  ): Promise<void> {
    return;
  }
}

export default UberShippingService;
