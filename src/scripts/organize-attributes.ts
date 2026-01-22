
import { ExecArgs } from "@medusajs/framework/types"
import { PRODUCT_ATTRIBUTES_MODULE } from "../modules/product-attributes"
import ProductAttributesService from "../modules/product-attributes/service"

// Mapping from attribute_set.php
const ATTRIBUTE_MAPPING = {
    'Electrical Characteristics': [
        'pa_input-voltage', 'pa_output-voltage', 'pa_current-per-channel', 'pa_maximum-current',
        'pa_rated-current', 'pa_power-consumption', 'pa_rated-power', 'pa_wattage',
        'pa_power-per-foot', 'pa_power-per-meter', 'pa_led-power-limit', 'pa_recommended-power-limit',
        'pa_elv-power-limit', 'pa_mlv-power-limit', 'pa_cfl-power-limit', 'pa_inc-halogen-power-limit',
        'pa_phase', 'pa_frequency-rating', 'pa_load-type', 'pa_driver-type',
        'pa_ballast-compatible', 'pa_interrupt-rating'
    ],

    'Lighting Characteristics': [
        'pa_beam-angle', 'pa_cri', 'pa_color', 'pa_color-options', 'pa_luminous-flux',
        'pa_equivalent', 'pa_led-per-feet', 'pa_led-per-meter', 'pa_life-span',
        'pa_lighting-cover', 'pa_chip-type', 'pa_modules-count', 'pa_maximum-led-lines',
        'pa_strip-width', 'pa_cuttable-length', 'pa_cutout', 'pa_totally-enclosed-fixture'
    ],

    'Physical Characteristics': [
        'pa_width', 'pa_height', 'pa_depth', 'pa_length', 'pa_thickness',
        'pa_external-width', 'pa_external-height', 'pa_internal-width', 'pa_recessed-depth',
        'pa_hole-size', 'pa_size-reference', 'pa_device-size-reference', 'pa_shape',
        'pa_material', 'pa_finish', 'pa_housing-type', 'pa_mounting-type',
        'pa_orientation', 'pa_trim-type', 'pa_pcb-finish', 'pa_wire-gauge', 'pa_conductor-range'
    ],

    'Control & Compatibility': [
        'pa_dimmable', 'pa_dimmer-compatibility', 'pa_compatible-dimmer-type', 'pa_control-distance',
        'pa_controllable-by', 'pa_remote-controller', 'pa_remote-control-mounting',
        'pa_hand-held-remote-compatible', 'pa_pairing-method', 'pa_app-compatible', 'pa_app-name',
        'pa_connection', 'pa_connection-type', 'pa_strip-compatibility', 'pa_compatible-products',
        'pa_input-cable', 'pa_number-of-wires', 'pa_number-of-poles', 'pa_number-of-gangs',
        'pa_number-of-receptacles', 'pa_number-of-usbs', 'pa_socket-type'
    ],

    'Certifications & Ratings': [
        'pa_ul-listed', 'pa_ul-recognized', 'pa_etl-listed', 'pa_ce-compliance', 'pa_fcc-compliance',
        'pa_dlc-compliance', 'pa_energy-star', 'pa_rohs-compliance', 'pa_rohs-conformant',
        'pa_ip-rating', 'pa_ic-rated', 'pa_airtight', 'pa_suitable-for-damp-location',
        'pa_suitable-for-wet-location', 'pa_explosion-proof', 'pa_tamper-resistant',
        'pa_temperature-rating', 'pa_environmental-conditions', 'pa_class-2', 'pa_class-ii'
    ],

    'General Information': [
        'pa_brand', 'pa_collection', 'pa_warranty', 'pa_included-accessories', 'pa_channels', 'pa_spyke'
    ]
}

export default async function organizeAttributes({ container }: ExecArgs) {
    try {
        console.log("🚀 Starting Attribute Organization...")

        const service: ProductAttributesService = container.resolve(PRODUCT_ATTRIBUTES_MODULE)

        console.log("✅ Service resolved")

        // 1. Fetch all existing attributes first
        const allAttributes = await service.listAttributeKeys({}, { take: 1000 })
        const attributeMap = new Map(allAttributes.map(a => [a.handle, a]))

        console.log(`📋 Found ${allAttributes.length} existing attributes.`)

        // 2. Fetch or Create Sets
        // Fetch ALL sets to avoid filter ambiguity
        let allSets = await service.listAttributeSets({}, { take: 999 })
        console.log(`📋 Found ${allSets.length} total sets in DB.`)

        for (const [setName, legacySlugs] of Object.entries(ATTRIBUTE_MAPPING)) {
            console.log(`\n📂 Processing Set: "${setName}"...`)

            // In-memory match
            let set = allSets.find(s => s.title === setName)

            if (!set) {
                console.log(`   ✨ Set not found in memory. Creating...`)
                try {
                    // Generate handle from title e.g. "Electrical Characteristics" -> "electrical-characteristics"
                    const handle = setName.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")

                    // ARRAY INPUT for standard services
                    const [created] = await service.createAttributeSets([{
                        title: setName,
                        handle: handle
                    }])
                    set = created
                    allSets.push(set) // Add to local cache
                } catch (e) {
                    console.log("   ⚠️ Creation failed:", (e as Error).message)
                    // Force re-fetch from DB in case of race condition/cache sync
                    const freshSets = await service.listAttributeSets({}, { take: 999 })
                    set = freshSets.find(s => s.title === setName)
                }
            }

            if (!set) {
                console.error(`   ❌ FAIL: Could not find or create set "${setName}". Skipping.`)
                continue
            }
            console.log(`   ✅ Target: ${set.title} (ID: ${set.id})`)

            // 3. Batch Update Attributes
            const updatePayloads = []

            for (const slug of legacySlugs) {
                // Strip 'pa_' prefix
                let handle = slug.replace(/^pa_/, "")

                const attribute = attributeMap.get(handle)

                if (attribute) {
                    if (attribute.attribute_set_id === set.id) continue

                    // console.log(`      -> Queueing: "${handle}"`)
                    updatePayloads.push({
                        id: attribute.id,
                        attribute_set_id: set.id
                    })
                }
            }

            if (updatePayloads.length > 0) {
                console.log(`   🔄 Updating ${updatePayloads.length} attributes...`)
                try {
                    await service.updateAttributeKeys(updatePayloads)
                    console.log(`   🎉 Success.`)
                } catch (err) {
                    console.error("   ❌ Update failed:", (err as Error).message)
                }
            } else {
                console.log(`   (Synced)`)
            }
        }

        console.log("\n✅ Organization Complete!")
    } catch (error) {
        console.error("❌ CRITICAL ERROR:", error)
    }
}
