import { Modules } from "@medusajs/utils";
import { ExecArgs } from "@medusajs/framework/types";

export default async function cleanupCarts({ container }: ExecArgs) {
    const logger = container.resolve("logger");

    // Resolve the Cart and Inventory Services
    const cartService = container.resolve(Modules.CART);
    const inventoryService = container.resolve(Modules.INVENTORY);

    logger.info("🗑️  Starting cleanup...");

    // --- CLEAN UP INVENTORY RESERVATIONS ---
    try {
        const [reservationItems] = await inventoryService.listReservationItems({}, { take: 10000 });

        if (reservationItems.length > 0) {
            const reservationIds = reservationItems.map((r) => r.id);
            await inventoryService.deleteReservationItems(reservationIds);
            logger.info(`✅ Deleted ${reservationIds.length} inventory reservations.`);
        } else {
            logger.info("✅ No inventory reservations found.");
        }
    } catch (error) {
        logger.warn(`⚠️  Could not clean reservations: ${error.message}`);
    }

    // --- CLEAN UP CARTS ---
    const [carts] = await cartService.listCarts({}, { select: ["id"], take: 10000 });

    if (carts.length > 0) {
        const cartIds = carts.map((cart) => cart.id);
        await cartService.deleteCarts(cartIds);
        logger.info(`✅ Deleted ${cartIds.length} carts.`);
    } else {
        logger.info("✅ No carts found.");
    }

    logger.info("🎉 Cleanup complete!");
}
