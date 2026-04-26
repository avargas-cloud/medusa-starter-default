import { ExecArgs } from "@medusajs/framework/types";
import { ContainerRegistrationKeys, Modules } from "@medusajs/utils";
import { IProductModuleService } from "@medusajs/types";
import { randomUUID } from "crypto";

const WHOLESALE_PRICE_LIST_ID = "plist_01KFTSDZZNTQRSYNMB4YST1HYA";

const DESCRIPTION = `<ul>
<li>Single Color LED Strip.</li>
<li>Every unit comes in a roll of 16.4 feet / 5 meters.</li>
<li>2640 LED COB Chips equidistantly located in the complete roll. UL listed.</li>
<li>Comes with 3m adhesive tape on the back of the strip.</li>
<li>Works with 24VDC power units.</li>
<li>For interior use only.</li>
<li>LED flexible strip for interior use.</li>
<li>Cut ANYWARE. FREECUT!</li>
<li>Power supply is not included.</li>
</ul>
<p>Related linear lighting components frequently needed:<br />
<a style="color: blue;" href="https://woocommerce-1561487-6061007.cloudwaysapps.com/product-category/by-categories/power-supplies" target="_blank" rel="noopener">Power Supplies</a><br />
<a style="color: blue;" href="https://woocommerce-1561487-6061007.cloudwaysapps.com/product-category/by-categories/aluminum-profiles" target="_blank" rel="noopener">Aluminum Channels</a><br />
<a style="color: blue;" href="https://woocommerce-1561487-6061007.cloudwaysapps.com/product-category/by-categories/controllers/low-voltage-dimmers-controllers" target="_blank" rel="noopener">Low Voltage Dimmers</a><br />
<a style="color: blue;" href="https://woocommerce-1561487-6061007.cloudwaysapps.com/product-category/by-categories/linear-lighting-accessories/for-single-color-led-strips" target="_blank" rel="noopener">Accessories</a></p>`;

const LONG_DESCRIPTION = `<p>LED strips are a flexible lighting solution for your lighting projects for incredible indirect illumination. These strips are designed for interior use, to bend and twist in just about any direction imaginable. Our LED strips use surface mounted LEDs, which allows for incredible flexibility without causing any damage to the product. In addition, all strips come with 3M adhesive tape allowing them to stick to most surfaces. This product comes in single color light, and you are able to choose between warm white (yellowish white) and cool white (white with a tint of blue). The strip can be cut at every 3rd LED. This feature allows you to obtain the right length of strip light for your application. After cutting the strip, the remaining segments of strips are able to be used by purchasing special connectors; check the LED strips accessories section. LED strips work with low voltage, 12VDC, making them suitable and safe for the above-mentioned interior lighting. A Power Supply is  required (not included), please calculate the total load of the circuit or consult a specialist.<br />\n<img src=\"https://woocommerce-1561487-6061007.cloudwaysapps.com/wp-content/uploads/2022/01/shutterstock_580756264.jpg\" alt=\"5-year-warranty\" width=\"370\" height=\"150\" /></p>\n<h2>Exceptional Warranty</h2>\n<p>We stand by our vision of providing excellent products and services so that you can create all of your projects without worrying about the future. That's why these LED Strips are covered by our exceptional 5 Year Warranty protection.</p>\n<p><img src=\"https://woocommerce-1561487-6061007.cloudwaysapps.com/wp-content/uploads/2022/03/shutterstock_1423389728.jpg\" alt=\"certified\" width=\"370\" height=\"150\" /></p>\n<h2>Certifications</h2>\n<p>Unlike other competitors LED Strips, these Strips come certified as UL Listed and Class 2. By using these strips and following local regulations, you are guaranteed that your projects will be up to code.</p>\n<p><img src=\"https://woocommerce-1561487-6061007.cloudwaysapps.com/wp-content/uploads/2021/05/PCB-Double-Layer.jpeg\" alt=\"\" width=\"370\" height=\"150\" /></p>\n<h2>Double Layer PCB</h2>\n<p>LED tapes made with Double layer PCB tend to have higher lumens and better heat dissipation to significantly improve its stability and life cycle. This helps the circuit board to withstand higher temperatures and electric currents.</p>\n<p><img src=\"https://woocommerce-1561487-6061007.cloudwaysapps.com/wp-content/uploads/2022/03/shutterstock_292310915.jpg\" alt=\"RGB\" width=\"370\" height=\"150\" /></p>\n<h2>High CRI of 90RA</h2>\n<p>The most readily apparent benefit of lights with higher CRI ratings is the improvement in safety as a result of increased visibility.</p>\n<p>The higher the CRI, the better the artificial light source is at rendering colors accurately. The lower the CRI value, the more unnatural colors appear when illuminated by the light source.</p>\n<p>A CRI value of 80+ will effectively portray colors and finishes. When the most accurate color rendering is essential, 90+ CRI values are recommended.</p>\n<p><img src=\"https://woocommerce-1561487-6061007.cloudwaysapps.com/wp-content/uploads/2022/03/3m.jpg\" alt=\"3m-double-adhesive-tape\" width=\"370\" height=\"150\" /></p>\n<h2>3M Strong Double Adhesive Tape</h2>\n<p>These LED Strips come equipped with 3M Double Sided adhesive tape. By using 3M tape, we guarantee that the strip will be able to resist and last its entire life cycle without any problems regarding adhesion to the surface where its installed.</p>\n<p><img title=\"COB LED STRIPS BANNER\" src=\"https://woocommerce-1561487-6061007.cloudwaysapps.com/wp-content/uploads/elementor/thumbs/COB-LED-STRIPS-BANNER-qbqhkgfmelhcm2d5bebnhb2zccnca95oo3ni5eiuxw.jpg\" alt=\"COB LED STRIPS BANNER\" /></p>\n<h2>High Density 2640 LED count</h2>\n<p>This LED Strip comes equipped with a staggering 1600 count LED COB chips throughout the entire roll. By using this particular strip, you can ensure that you're achieving a very smooth and even lighting structure in order to obtain a virtually dot-less look. Best suited for front facing installations.</p>\n<p><img src=\"https://woocommerce-1561487-6061007.cloudwaysapps.com/wp-content/uploads/2022/01/voltage-12V.jpeg\" alt=\"12v-voltage\" width=\"370\" height=\"150\" /></p>\n<h2>Low Voltage 12V DC</h2>\n<p>Among the many benefits of using low voltage LED we can mention that safety is probably the principal one. Due to the significantly lower voltage running through the light fittings themselves, low voltage lighting is much safer to use.</p>\n<p><img src=\"https://woocommerce-1561487-6061007.cloudwaysapps.com/wp-content/uploads/2024/12/freecut.jpg\" alt=\"freecut\" width=\"370\" height=\"150\" /></p>\n<h2>Cut Anywhere along the LED Strip</h2>\n<p>Designed for versatility, the strip can be easily cut at any point, allowing you to tailor it precisely to your requirements.</p>\n<p><img src=\"https://woocommerce-1561487-6061007.cloudwaysapps.com/wp-content/uploads/2022/01/strip-width-8mm-1.jpg\" alt=\"8mm-strip-width\" width=\"370\" height=\"150\" /></p>\n<h2>8mm Strip Width</h2>\n<p>This LED Strip has a width of 8mm which permits it to be installed in tight spots and custom made projects.</p>`;

const CATEGORY_IDS = [
  "pcat_01KGAD1KQXVZ4BKE3YEGSEVVMS", // WHITE LED STRIPS
  "pcat_01KGAD1KQXDWJEP7HE92G5FCS4", // LED Strips
  "pcat_01KGAD1KQXRN58BXJG5CX11BWT", // INDOOR
  "pcat_01KGAD1KQY7DNFZTQ95FEEQPGW", // SINGLE COLOR
];

const VARIANTS = [
  {
    title: "3000K",
    sku: "ESP-SFA50W0830",
    colorOption: "3000K",
    mpn: "FE10W-P0-G1COB93024V528S1W08L05",
    variation: "3000k",
    qb_avg_cost: 25.18667,
    qb_purchase_desc:
      "LED Freecut COB Strip, 24VDC, 528LED/Meter, 50W/Roll, 10W/Meter, 3.66W/Ft, 329 LM/ft, 3000K, 8mm, White Board, IP20, UL Listed, 5 meters/16.4 feet. 6ft 24V 3A Dupont Male Connector on both ends  (black cable, dotted cable is negative). It should include the 2 X L813 from Fongkit.",
    sales_description:
      "LED Freecut COB Strip, 24VDC, 528LED/Meter, 50W/Roll, 10W/Meter, 3.66W/Ft, 329 LM/ft, 3000K, 8mm, White Board, IP20, UL Listed, 5 meters/16.4 feet. 6ft 24V 3A Dupont Male Connector on both ends (black cable, dotted cable is negative). 5 year warranty.",
  },
  {
    title: "4000K",
    sku: "ESP-SFA50W0840",
    colorOption: "4000K",
    mpn: "FE10W-P0-G1COB94024V528S1W08L05",
    variation: "4000k",
    qb_avg_cost: 21.9019,
    qb_purchase_desc:
      "LED Freecut COB Strip, 24VDC, 528LED/Meter, 50W/Roll, 10W/Meter, 3.66W/Ft, 329 LM/ft, 4000K, 8mm, White Board, IP20, UL Listed, 5 meters/16.4 feet. 6ft 24V 3A Dupont Male Connector on both ends  (black cable, dotted cable is negative). It should include the 2 X L813 from Fongkit.",
    sales_description:
      "LED Freecut COB Strip, 24VDC, 528LED/Meter, 50W/Roll, 10W/Meter, 3.66W/Ft, 329 LM/ft, 4000K, 8mm, White Board, IP20, UL Listed, 5 meters/16.4 feet. 6ft 24V 3A Dupont Male Connector on both ends (black cable, dotted cable is negative). 5 year warranty.",
  },
  {
    title: "6000K",
    sku: "ESP-SFA50W0860",
    colorOption: "6000K",
    mpn: "FE10W-P0-G1COB96024V528S1W08L05",
    variation: "6000k",
    qb_avg_cost: 21.84762,
    qb_purchase_desc:
      "LED Strip Freecut COB, 24VDC, 528LED/Meter, 50W/Roll, 10W/Meter, 3.66W/Ft, 329 LM/ft, 6000K, 8mm, White Board, IP20, UL Listed, 5 meters/16.4 feet. 6ft 24V 3A Dupont Male Connector on both ends  (black cable, dotted cable is negative). It should include the 2 X L813 from Fongkit.",
    sales_description:
      "LED Strip Freecut COB, 24VDC, 528LED/Meter, 50W/Roll, 10W/Meter, 3.66W/Ft, 329 LM/ft, 6000K, 8mm, White Board, IP20, UL Listed, 5 meters/16.4 feet. 6ft 24V 3A Dupont Male Connector on both ends (black cable, dotted cable is negative). 5 year warranty.",
  },
];

export default async function createEspSfa50w08({ container }: ExecArgs) {
  const logger = container.resolve(ContainerRegistrationKeys.LOGGER);
  const productModule: IProductModuleService = container.resolve(Modules.PRODUCT);
  const query = container.resolve(ContainerRegistrationKeys.QUERY);
  const knex = (container as any).resolve("__pg_connection__");

  logger.info("=".repeat(60));
  logger.info("Creating product ESP-SFA50W08 with 3 variants");
  logger.info("=".repeat(60));

  // Step 1: Create product + variants + images + options
  const [product] = await productModule.createProducts([
    {
      title: "UL FREECUT COB LED Strip Single Color, Bright Output",
      handle: "esp-sfa50w08",
      subtitle: "test",
      description: DESCRIPTION,
      status: "published",
      thumbnail:
        "https://bucket-production-2e09.up.railway.app/medusa-media/products/18802.png",
      weight: 0.25,
      length: 7.38,
      width: 8.25,
      height: 0.63,
      type_id: "ptyp_01KFTQDGQKTZ39J5CH3TRR7D3S",
      discountable: true,
      metadata: {
        prerender: true,
        qb_item_type: "Inventory",
        long_description: LONG_DESCRIPTION,
        qb_vendor_list_id: "80000B28-1495576857",
        variant_attributes: ["01KFK5SM3EDB6V3NQXGKQEZ8QM"],
        primary_category_id: "pcat_01KGAD1KQXVZ4BKE3YEGSEVVMS",
        qb_vendor_full_name: "SHENZHEN LEDMY CO.,LTD",
        is_sourced_via_agent: true,
        main_category_breadcrumbs: [
          {
            id: "pcat_01KGAD1KQV29RKZZHEZ4N88B8H",
            name: "BY CATEGORIES",
            handle: "by-categories",
          },
          {
            id: "pcat_01KGAD1KQXDWJEP7HE92G5FCS4",
            name: "LED Strips",
            handle: "led-strips",
          },
          {
            id: "pcat_01KGAD1KQXVZ4BKE3YEGSEVVMS",
            name: "WHITE LED STRIPS",
            handle: "led-strips-white",
          },
        ],
        qb_cogs_account_full_name: "Purchases - Resale Items:Ecopowertech",
        qb_income_account_full_name:
          "Sales:Ecopowertech:Ecopowertech - LED Strips",
      },
      images: [
        {
          url: "https://bucket-production-2e09.up.railway.app/medusa-media/products/18802.png",
        },
        {
          url: "https://bucket-production-2e09.up.railway.app/medusa-media/products/18801.png",
        },
        {
          url: "https://bucket-production-2e09.up.railway.app/medusa-media/products/18804.png",
        },
        {
          url: "https://bucket-production-2e09.up.railway.app/medusa-media/products/18803.png",
        },
        {
          url: "https://bucket-production-2e09.up.railway.app/medusa-media/products/19098.png",
        },
      ],
      options: [
        { title: "Color Options", values: ["3000K", "4000K", "6000K"] },
      ],
      variants: VARIANTS.map((v) => ({
        title: v.title,
        sku: v.sku,
        manage_inventory: true,
        allow_backorder: true,
        weight: 0.25,
        length: 7,
        width: 8,
        height: 1,
        options: { "Color Options": v.colorOption },
        prices: [{ currency_code: "usd", amount: 56.75 }],
        metadata: {
          mpn: v.mpn,
          qb_sku: v.sku,
          variation: v.variation,
          managed_by: "attributes",
          qb_avg_cost: v.qb_avg_cost,
          qb_is_active: true,
          shipping_width: 8.25,
          shipping_height: 0.63,
          shipping_length: 7.38,
          shipping_weight: 0.25,
          qb_purchase_cost: 16.2,
          qb_purchase_desc: v.qb_purchase_desc,
          qb_vendor_list_id: "80000B28-1495576857",
          sales_description: v.sales_description,
        },
      })),
    } as any,
  ]);

  logger.info(`✅ Product created: ${product.id} (handle: ${(product as any).handle})`);

  // Step 2: Link categories via direct insert
  logger.info("Linking categories...");
  for (const catId of CATEGORY_IDS) {
    await knex.raw(
      `INSERT INTO product_category_product (product_id, product_category_id)
       VALUES (?, ?)
       ON CONFLICT DO NOTHING`,
      [product.id, catId]
    );
  }
  logger.info(`✅ ${CATEGORY_IDS.length} categories linked`);

  // Step 3: Add wholesale prices
  logger.info("Adding wholesale prices...");
  const { data: createdVariants } = await query.graph({
    entity: "product_variant",
    fields: ["id", "sku", "price_set.id"],
    filters: { product_id: product.id },
  });

  let wholesaleApplied = 0;
  for (const v of createdVariants as Array<{
    id: string;
    sku: string;
    price_set: { id: string } | null;
  }>) {
    if (!v.price_set?.id) {
      logger.warn(`  Variant ${v.sku} has no price_set — skipping wholesale`);
      continue;
    }
    const priceId = `price_${randomUUID().replace(/-/g, "")}`;
    await knex.raw(
      `INSERT INTO price (id, price_set_id, price_list_id, currency_code, amount, raw_amount, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?::jsonb, NOW(), NOW())`,
      [
        priceId,
        v.price_set.id,
        WHOLESALE_PRICE_LIST_ID,
        "usd",
        51.99,
        JSON.stringify({ value: "51.99", precision: 20 }),
      ]
    );
    wholesaleApplied++;
    logger.info(`  ✅ Wholesale price $51.99 added for ${v.sku} (variant ${v.id})`);
  }

  logger.info("=".repeat(60));
  logger.info("DONE");
  logger.info(`  Product ID : ${product.id}`);
  logger.info(`  Handle     : esp-sfa50w08`);
  logger.info(`  Variants   : ${createdVariants.length} created`);
  logger.info(`  Wholesale  : ${wholesaleApplied} prices inserted`);
  for (const v of createdVariants as Array<{ id: string; sku: string }>) {
    logger.info(`    ${v.sku} → ${v.id}`);
  }
  logger.info("=".repeat(60));
  logger.info("Next step: query QuickBooks for qb_id of the 3 new variants");
}
