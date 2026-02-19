/**
 * box-packing.ts
 *
 * Greedy box packing algorithm for UPS shipments.
 * Tries to fit all items into the smallest single box first (XS→XXL).
 * If total volume exceeds XXL, finds the optimal 2-box combination.
 *
 * Assumptions:
 * - Volume-based packing (not 3D spatial — fast and good enough for rate calc)
 * - 70% packing efficiency (items don't pack perfectly)
 * - Weight limit per box: 70 lbs (UPS max for standard packages)
 */

export interface BoxSize {
    name: string
    length: number  // inches
    width: number  // inches
    height: number  // inches
    volume: number  // cubic inches (pre-computed)
    maxWeight: number // lbs
}

export interface PackageSpec {
    weight: number
    length: number
    width: number
    height: number
}

// Standard box sizes — ordered XS → XXL
export const STANDARD_BOXES: BoxSize[] = [
    { name: "XS", length: 8, width: 6, height: 4, volume: 192, maxWeight: 70 },
    { name: "S", length: 12, width: 9, height: 6, volume: 648, maxWeight: 70 },
    { name: "M", length: 16, width: 12, height: 8, volume: 1536, maxWeight: 70 },
    { name: "L", length: 20, width: 16, height: 10, volume: 3200, maxWeight: 70 },
    { name: "XL", length: 24, width: 18, height: 14, volume: 6048, maxWeight: 70 },
    { name: "XXL", length: 30, width: 24, height: 18, volume: 12960, maxWeight: 70 },
]

const PACKING_EFFICIENCY = 0.70  // 70% — items don't pack perfectly

interface CartItem {
    weight: number   // lbs per unit
    length: number   // inches
    width: number   // inches
    height: number   // inches
    quantity: number
}

/**
 * Calculate the volume of a single item (with a small air buffer).
 */
function itemVolume(item: CartItem): number {
    return item.length * item.width * item.height
}

/**
 * Find the smallest single box that fits all items by volume and weight.
 * Returns null if no single box is large enough.
 */
function fitSingleBox(items: CartItem[]): { box: BoxSize; totalWeight: number } | null {
    const totalVolume = items.reduce((sum, item) => sum + itemVolume(item) * item.quantity, 0)
    const totalWeight = items.reduce((sum, item) => sum + item.weight * item.quantity, 0)
    const requiredVolume = totalVolume / PACKING_EFFICIENCY

    // The largest single dimension across all items — the box must be at least this long
    const maxItemDim = items.reduce((max, item) =>
        Math.max(max, item.length, item.width, item.height), 0)

    for (const box of STANDARD_BOXES) {
        const boxMaxDim = Math.max(box.length, box.width, box.height)
        if (
            requiredVolume <= box.volume &&
            totalWeight <= box.maxWeight &&
            maxItemDim <= boxMaxDim  // item must physically fit in the box
        ) {
            return { box, totalWeight }
        }
    }
    return null
}


/**
 * Split items into two groups by volume and find the optimal 2-box combination.
 * Strategy: put the heaviest/largest items in the bigger box, rest in smaller.
 * Returns the pair with the smallest total volume (most economical).
 */
function fitTwoBoxes(items: CartItem[]): PackageSpec[] {
    const totalVolume = items.reduce((sum, item) => sum + itemVolume(item) * item.quantity, 0)
    const totalWeight = items.reduce((sum, item) => sum + item.weight * item.quantity, 0)

    // Try each split point: what fraction goes in box 1 vs box 2
    // Simple approach: split by volume halves, find best box pair
    const splitRatios = [0.5, 0.6, 0.4, 0.7, 0.3]

    let bestPair: PackageSpec[] | null = null
    let bestTotalVolume = Infinity

    for (const ratio of splitRatios) {
        const vol1 = (totalVolume * ratio) / PACKING_EFFICIENCY
        const vol2 = (totalVolume * (1 - ratio)) / PACKING_EFFICIENCY
        const w1 = totalWeight * ratio
        const w2 = totalWeight * (1 - ratio)

        const box1 = STANDARD_BOXES.find(b => b.volume >= vol1 && b.maxWeight >= w1)
        const box2 = STANDARD_BOXES.find(b => b.volume >= vol2 && b.maxWeight >= w2)

        if (!box1 || !box2) continue

        const combinedVolume = box1.volume + box2.volume
        if (combinedVolume < bestTotalVolume) {
            bestTotalVolume = combinedVolume
            bestPair = [
                { weight: w1, length: box1.length, width: box1.width, height: box1.height },
                { weight: w2, length: box2.length, width: box2.width, height: box2.height },
            ]
        }
    }

    // Fallback: two XXL boxes
    if (!bestPair) {
        const w = totalWeight / 2
        const xxl = STANDARD_BOXES[STANDARD_BOXES.length - 1]!
        bestPair = [
            { weight: w, length: xxl.length, width: xxl.width, height: xxl.height },
            { weight: w, length: xxl.length, width: xxl.width, height: xxl.height },
        ]
    }

    return bestPair
}

/**
 * Maximum dimension of the largest standard box.
 * Any item with a dimension exceeding this CANNOT fit in a standard box
 * and must ship as its own package using its actual dimensions.
 */
const LONG_ITEM_MAX_DIM = 30 // inches (= XXL box length)

/**
 * Main entry point.
 * Given cart items with dimensions, returns an array of PackageSpec
 * (one or more packages) to send to the UPS API.
 *
 * Long items (any dimension > 30") are separated into their own packages
 * using their actual dimensions (× quantity). Regular items are packed
 * volumetrically into standard boxes as before.
 */
export function packItems(rawItems: Array<{
    weight: number
    length: number
    width: number
    height: number
    quantity: number
}>): PackageSpec[] {
    // Normalize defaults
    const items: CartItem[] = rawItems.map(item => ({
        weight: item.weight || 1,
        length: item.length || 1,
        width: item.width || 1,
        height: item.height || 1,
        quantity: item.quantity || 1,
    }))

    const longItems: CartItem[] = []
    const regularItems: CartItem[] = []

    for (const item of items) {
        const maxDim = Math.max(item.length, item.width, item.height)
        if (maxDim > LONG_ITEM_MAX_DIM) {
            longItems.push(item)
        } else {
            regularItems.push(item)
        }
    }

    const packages: PackageSpec[] = []

    // ── Long items → bundled, split when weight >70 lbs OR cross-section >16 in² ──
    // Length is the same for all units in a bundle — what grows is the cross-section
    // (width × height per unit added). 16 in² ≈ a 4"×4" bundle profile.
    const LONG_BOX_MAX_WEIGHT = 70  // lbs — UPS standard max
    const LONG_BOX_MAX_CROSS_SECT = 12  // in² — approx 3.5"×3.5" bundle cross-section
    if (longItems.length > 0) {
        const maxLength = Math.max(...longItems.map(i => i.length))
        const maxWidth = Math.max(...longItems.map(i => i.width))
        const maxHeight = Math.max(...longItems.map(i => i.height))

        // Flatten into individual units so we can chunk precisely
        const units: { weight: number; crossSection: number }[] = []
        for (const item of longItems) {
            const cs = item.width * item.height
            for (let u = 0; u < item.quantity; u++) {
                units.push({ weight: item.weight, crossSection: cs })
            }
        }

        let chunkWeight = 0
        let chunkCrossSection = 0
        let chunkCount = 0
        let pkgNum = 0

        for (const unit of units) {
            const wouldExceedWeight = chunkWeight + unit.weight > LONG_BOX_MAX_WEIGHT
            const wouldExceedCross = chunkCrossSection + unit.crossSection > LONG_BOX_MAX_CROSS_SECT

            if (chunkCount > 0 && (wouldExceedWeight || wouldExceedCross)) {
                packages.push({ weight: chunkWeight, length: maxLength, width: maxWidth, height: maxHeight })
                console.log(`📦 Long bundle pkg${++pkgNum} (×${chunkCount}): ${maxLength}×${maxWidth}×${maxHeight}in, ${chunkWeight.toFixed(2)}lbs, cross=${chunkCrossSection.toFixed(2)}in²`)
                chunkWeight = 0; chunkCrossSection = 0; chunkCount = 0
            }
            chunkWeight += unit.weight
            chunkCrossSection += unit.crossSection
            chunkCount++
        }

        // Flush last chunk
        if (chunkCount > 0) {
            packages.push({ weight: chunkWeight, length: maxLength, width: maxWidth, height: maxHeight })
            console.log(`📦 Long bundle pkg${++pkgNum} (×${chunkCount}): ${maxLength}×${maxWidth}×${maxHeight}in, ${chunkWeight.toFixed(2)}lbs, cross=${chunkCrossSection.toFixed(2)}in²`)
        }
    }



    // ── Regular items → volumetric packing into standard boxes ────────────────
    if (regularItems.length > 0) {
        const single = fitSingleBox(regularItems)
        if (single) {
            console.log(`📦 Box packing: single ${single.box.name} (${single.box.length}×${single.box.width}×${single.box.height}in, ${single.totalWeight.toFixed(2)}lbs)`)
            packages.push({
                weight: single.totalWeight,
                length: single.box.length,
                width: single.box.width,
                height: single.box.height,
            })
        } else {
            const twoBoxes = fitTwoBoxes(regularItems)
            console.log(`📦 Box packing: 2 packages — ${twoBoxes.map(p => `${p.length}×${p.width}×${p.height}in ${p.weight.toFixed(2)}lbs`).join(" + ")}`)
            packages.push(...twoBoxes)
        }
    }

    // ── Edge case: only long items, nothing else ───────────────────────────────
    if (packages.length === 0) {
        // Fallback (shouldn't happen given logic above, but just in case)
        const xxl = STANDARD_BOXES[STANDARD_BOXES.length - 1]!
        packages.push({ weight: 1, length: xxl.length, width: xxl.width, height: xxl.height })
    }

    return packages
}

