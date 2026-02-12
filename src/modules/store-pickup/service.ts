import { AbstractFulfillmentProviderService } from "@medusajs/framework/utils"

class StorePickupService extends AbstractFulfillmentProviderService {
    static identifier = "custom-fulfillment"

    async validateOption(data: any): Promise<boolean> {
        return true
    }

    async validateFulfillmentData(
        optionData: any,
        data: any,
        context: any
    ): Promise<any> {
        return data
    }

    async canCalculate(data: any): Promise<boolean> {
        return true
    }

    async calculatePrice(
        optionData: any,
        data: any,
        context: any
    ): Promise<number> {
        // Store pickup is always free
        return 0
    }

    async createFulfillment(
        data: any,
        items: any,
        order: any,
        fulfillment: any
    ): Promise<any> {
        return {
            data: {
                method: "store-pickup",
                instructions: "Customer will pick up order at store location"
            }
        }
    }

    async cancelFulfillment(fulfillment: any): Promise<any> {
        return {}
    }

    async getFulfillmentOptions(): Promise<any[]> {
        return [
            {
                id: "store-pickup",
                name: "Store Pickup",
            }
        ]
    }

    async retrieveDocuments(
        fulfillmentData: any,
        documentType: string
    ): Promise<any> {
        return null
    }
}

export default StorePickupService
