import { AbstractPaymentProvider } from "@medusajs/utils"
import {
    InitiatePaymentInput,
    InitiatePaymentOutput,
    UpdatePaymentInput,
    UpdatePaymentOutput,
    DeletePaymentInput,
    DeletePaymentOutput,
    AuthorizePaymentInput,
    AuthorizePaymentOutput,
    CapturePaymentInput,
    CapturePaymentOutput,
    CancelPaymentInput,
    CancelPaymentOutput,
    RefundPaymentInput,
    RefundPaymentOutput,
    RetrievePaymentInput,
    RetrievePaymentOutput,
    GetPaymentStatusInput,
    GetPaymentStatusOutput,
    ProviderWebhookPayload,
    WebhookActionResult,
} from "@medusajs/types"
import https from "https"

// ─── Options ──────────────────────────────────────────────────────────────────

interface AuthnetOptions {
    apiLoginId: string
    transactionKey: string
    environment?: "production" | "sandbox"
}

interface OpaqueData {
    dataDescriptor: string
    dataValue: string
}

// ─── Service ──────────────────────────────────────────────────────────────────

class AuthorizeNetPaymentService extends AbstractPaymentProvider<AuthnetOptions> {

    static identifier = "authorize-net"

    private apiLoginId: string
    private transactionKey: string
    private endpoint: string

    constructor(container: any, options: AuthnetOptions) {
        super(container, options)
        this.apiLoginId = options.apiLoginId
        this.transactionKey = options.transactionKey
        const env = options.environment ?? "sandbox"
        this.endpoint = env === "production"
            ? "api.authorize.net"
            : "apitest.authorize.net"
    }

    // ─── Low-level HTTPS POST ─────────────────────────────────────────────────

    private async authnetRequest(payload: object): Promise<any> {
        const body = JSON.stringify(payload)
        return new Promise((resolve, reject) => {
            const req = https.request(
                {
                    hostname: this.endpoint,
                    path: "/xml/v1/request.api",
                    method: "POST",
                    headers: {
                        "Content-Type": "application/json",
                        "Content-Length": Buffer.byteLength(body),
                    },
                },
                (res) => {
                    let data = ""
                    res.on("data", (chunk) => (data += chunk))
                    res.on("end", () => {
                        try {
                            resolve(JSON.parse(data.replace(/^\uFEFF/, "")))
                        } catch {
                            reject(new Error(`Authorize.net non-JSON response: ${data}`))
                        }
                    })
                }
            )
            req.on("error", reject)
            req.write(body)
            req.end()
        })
    }

    private get merchantAuth() {
        return { name: this.apiLoginId, transactionKey: this.transactionKey }
    }

    private isSuccess(r: any): boolean {
        return r?.messages?.resultCode === "Ok" || r?.transactionResponse?.responseCode === "1"
    }

    private extractError(r: any): string {
        return (
            r?.transactionResponse?.errors?.[0]?.errorText ||
            r?.messages?.message?.[0]?.text ||
            "Unknown Authorize.net error"
        )
    }

    // ─── Medusa Provider Interface ────────────────────────────────────────────

    async initiatePayment(data: InitiatePaymentInput): Promise<InitiatePaymentOutput> {
        // Generate a local session ID to track this payment
        const sessionId = `authnet-${Date.now()}-${Math.random().toString(36).slice(2)}`
        return {
            id: sessionId,
            data: {
                status: "pending",
                amount: data.amount,
                currency_code: data.currency_code,
                authnet_transaction_id: null,
            },
        }
    }

    async updatePayment(data: UpdatePaymentInput): Promise<UpdatePaymentOutput> {
        return {
            data: {
                ...(data.data ?? {}),
                amount: data.amount,
                currency_code: data.currency_code,
            },
        }
    }

    async deletePayment(data: DeletePaymentInput): Promise<DeletePaymentOutput> {
        return { data: data.data ?? {} }
    }

    async retrievePayment(data: RetrievePaymentInput): Promise<RetrievePaymentOutput> {
        const sessionData = data.data ?? {}
        const txId = sessionData?.authnet_transaction_id as string | undefined

        if (!txId) {
            return { data: sessionData }
        }

        try {
            const response = await this.authnetRequest({
                getTransactionDetailsRequest: {
                    merchantAuthentication: this.merchantAuth,
                    transId: txId,
                },
            })
            return { data: { ...sessionData, authnet_details: response?.transaction ?? {} } }
        } catch (err: any) {
            console.error("[AuthorizeNet] retrievePayment error:", err.message)
            return { data: sessionData }
        }
    }

    async getPaymentStatus(data: GetPaymentStatusInput): Promise<GetPaymentStatusOutput> {
        const status = (data.data?.status as string) ?? "pending"
        const validStatuses = ["pending", "captured", "canceled", "authorized", "requires_more", "error"]
        return {
            status: (validStatuses.includes(status) ? status : "pending") as any
        }
    }

    /**
     * authorizePayment: called when order is placed.
     * We do an auth+capture in one step using the Accept.js opaqueData
     * stored in the payment session data by our frontend API proxy.
     */
    async authorizePayment(data: AuthorizePaymentInput): Promise<AuthorizePaymentOutput> {
        try {
            // (data as any).amount = Medusa's authoritative amount in cents at time of auth
            const medusaAmount: number | undefined = (data as any).amount
            const captureResult = await this.capturePayment(
                medusaAmount
                    ? { data: { ...(data.data ?? {}), _medusaAmount: medusaAmount } }
                    : { data: data.data }
            )
            return {
                data: captureResult.data ?? data.data ?? {},
                status: "authorized" as any,
            }
        } catch (err: any) {
            console.error("[AuthorizeNet] authorizePayment error:", err.message)
            throw err
        }
    }

    /**
     * capturePayment: charges the card using the Accept.js opaqueData nonce
     * stored in the payment session by our frontend proxy.
     */
    async capturePayment(data: CapturePaymentInput): Promise<CapturePaymentOutput> {
        const sessionData = data.data ?? {}
        const opaqueData = sessionData?.opaqueData as OpaqueData | undefined
        const billingAddress = sessionData?.billingAddress as Record<string, string> | undefined

        // Priority: Medusa's authoritative amount (passed via _medusaAmount) > stored amount
        // _medusaAmount is set by authorizePayment() from (data as any).amount
        const amountSource = (sessionData?._medusaAmount as number | undefined) ?? (sessionData?.amount as number | undefined);

        console.log(`[AuthorizeNet] DEBUG AUDIT: Capture raw amount input: ${amountSource}, type: ${typeof amountSource}`);
        console.log(`[AuthorizeNet] DEBUG AUDIT: Capture medusaAmount param: ${(data as any).amount}, type: ${typeof (data as any).amount}`);

        const amountCents: number =
            (sessionData?._medusaAmount as number | undefined) ??
            (sessionData?.amount as number | undefined) ??
            0;

        if (!opaqueData?.dataValue) {
            throw new Error("No Accept.js opaqueData — card not tokenized")
        }

        if (!amountCents) {
            throw new Error("No amount in payment session or input")
        }

        const amountDollars = (amountCents / 100).toFixed(2)
        console.log(`[AuthorizeNet] Charging $${amountDollars} (${amountCents} cents)`)

        const payload: any = {
            createTransactionRequest: {
                merchantAuthentication: this.merchantAuth,
                transactionRequest: {
                    transactionType: "authCaptureTransaction",
                    amount: amountDollars,
                    payment: {
                        opaqueData: {
                            dataDescriptor: opaqueData.dataDescriptor,
                            dataValue: opaqueData.dataValue,
                        },
                    },
                },
            },
        }

        if (billingAddress) {
            payload.createTransactionRequest.transactionRequest.billTo = {
                firstName: billingAddress.firstName ?? "",
                lastName: billingAddress.lastName ?? "",
                company: billingAddress.company ?? "",
                address: billingAddress.address1 ?? "",
                city: billingAddress.city ?? "",
                state: billingAddress.state ?? "",
                zip: billingAddress.zip ?? "",
                country: billingAddress.country ?? "US",
            }
        }

        const response = await this.authnetRequest(payload)

        if (!this.isSuccess(response)) {
            const errMsg = this.extractError(response)
            console.error(`[AuthorizeNet] Capture failed: ${errMsg}`)
            throw new Error(errMsg)
        }

        const txId = response.transactionResponse?.transId
        if (!txId || txId === "0") {
            // Sandbox sometimes returns transId=0 for test cards — log a visible warning
            console.warn(`[AuthorizeNet] ⚠️  transId=0 returned — this may be a sandbox test response. Check Authorize.net transaction logs.`)
        }
        console.log(`[AuthorizeNet] ✅ Capture success transId=${txId} amount=$${amountDollars}`)

        return {
            data: {
                ...sessionData,
                status: "captured",
                authnet_transaction_id: txId,
                authnet_auth_code: response.transactionResponse?.authCode,
            },
        }
    }

    /** Void (cancel) an unsettled transaction */
    async cancelPayment(data: CancelPaymentInput): Promise<CancelPaymentOutput> {
        const sessionData = data.data ?? {}
        const txId = sessionData?.authnet_transaction_id as string | undefined

        if (!txId) {
            return { data: { ...sessionData, status: "canceled" } }
        }

        const response = await this.authnetRequest({
            createTransactionRequest: {
                merchantAuthentication: this.merchantAuth,
                transactionRequest: {
                    transactionType: "voidTransaction",
                    refTransId: txId,
                },
            },
        })

        if (!this.isSuccess(response)) {
            const errMsg = this.extractError(response)
            console.error(`[AuthorizeNet] Void failed: ${errMsg}`)
            throw new Error(errMsg)
        }

        console.log(`[AuthorizeNet] ✅ Void success transId=${txId}`)
        return { data: { ...sessionData, status: "canceled" } }
    }

    /** Refund a settled transaction (full or partial) */
    async refundPayment(data: RefundPaymentInput): Promise<RefundPaymentOutput> {
        const sessionData = data.data ?? {}
        const txId = sessionData?.authnet_transaction_id as string | undefined
        const refundAmount = data.amount

        if (!txId) {
            throw new Error("No transaction ID to refund")
        }

        const amountDollars = (Number(refundAmount) / 100).toFixed(2)
        const last4 = (sessionData?.card_last4 as string) ?? "0000"

        const response = await this.authnetRequest({
            createTransactionRequest: {
                merchantAuthentication: this.merchantAuth,
                transactionRequest: {
                    transactionType: "refundTransaction",
                    amount: amountDollars,
                    payment: {
                        creditCard: {
                            cardNumber: last4,
                            expirationDate: "XXXX",
                        },
                    },
                    refTransId: txId,
                },
            },
        })

        if (!this.isSuccess(response)) {
            const errMsg = this.extractError(response)
            console.error(`[AuthorizeNet] Refund failed: ${errMsg}`)
            throw new Error(errMsg)
        }

        const refundTxId = response.transactionResponse?.transId
        console.log(`[AuthorizeNet] ✅ Refund $${amountDollars} refundTransId=${refundTxId}`)
        return {
            data: {
                ...sessionData,
                authnet_refund_transaction_id: refundTxId,
            },
        }
    }

    /** Webhook handler — for Authorize.net webhooks */
    async getWebhookActionAndData(
        _payload: ProviderWebhookPayload["payload"]
    ): Promise<WebhookActionResult> {
        return { action: "not_supported" }
    }
}

export default AuthorizeNetPaymentService
