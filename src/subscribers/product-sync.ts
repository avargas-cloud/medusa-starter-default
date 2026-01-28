import { SubscriberArgs, type SubscriberConfig } from "@medusajs/framework"
import { syncSearchWorkflow } from "../workflows/sync-search"

export default async function productSyncHandler({
    event: { data, name },
    container,
}: SubscriberArgs<{ id: string }>) {

    // LOG DE DEBUG: Esto confirmará si Medusa está escuchando
    const logger = container.resolve("logger")
    logger.info(`⚡ EVENTO DETECTADO: ${name} para ID: ${data.id}`)

    // Detectar si es variante o producto para pasar el tipo correcto
    const type = name.includes("variant") ? "variant" : "product"

    await syncSearchWorkflow(container).run({
        input: { id: data.id, type, eventName: name }
    })
}

// Configuración Crítica: Escuchar variantes Y productos
export const config: SubscriberConfig = {
    event: [
        "product.created",
        "product.updated",
        "product.deleted",
        // IMPORTANTE: Escuchar cambios en variantes para arreglar el problema del Timestamp
        "product-variant.created",
        "product-variant.updated",
        "product-variant.deleted"
    ],
}
