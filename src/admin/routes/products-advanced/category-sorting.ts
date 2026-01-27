/**
 * Category Sorting Configuration
 * 
 * Defines the priority order for categories in the "Advance Product Page" dropdown.
 * Categories listed here will appear at the top in the specified order.
 * All other categories will be sorted alphabetically.
 * 
 * MATCHING RULES:
 * - Case-insensitive partial match
 * - Example: "Backlighting" matches "SIGN & BACKLIGHTING"
 * - Example: "Controllers" matches "LED Controllers" or "CONTROLLERS"
 */

export const CATEGORY_PRIORITY_LIST = [
    "LED Strips",
    "LED Channels",
    "LED Drivers",
    "Controller", // Matches "CONTROLLERS" or "LED Controllers"
    "Backlighting", // Matches "SIGN & BACKLIGHTING"
];
