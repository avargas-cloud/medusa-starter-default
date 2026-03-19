import { ExecArgs } from "@medusajs/framework/types"
import { Modules } from "@medusajs/utils"
import { IProductModuleService } from "@medusajs/framework/types"
import * as fs from "fs"
import * as path from "path"

export default async function exportProducts({ container }: ExecArgs) {
    const productService: IProductModuleService = container.resolve(Modules.PRODUCT)

    const [products, count] = await productService.listAndCountProducts(
        {},
        {
            take: 200,
            relations: ["variants", "variants.options", "options"]
        }
    )

    console.log(`Total Products: ${count}`)

    let output = `LISTA COMPLETA DE PRODUCTOS - EcoPowerTech\n`
    output += `Generado: ${new Date().toISOString()}\n`
    output += `Total: ${count} productos\n`
    output += `${"=".repeat(80)}\n\n`

    products.forEach((p, i) => {
        const sku = p.external_id || p.variants?.[0]?.sku || "SIN-SKU"
        output += `${i + 1}. [${sku}] ${p.title}\n`
        output += `   Status: ${p.status}\n`
        output += `   Variantes: ${p.variants?.length || 0}\n`

        if (p.variants && p.variants.length > 0) {
            p.variants.forEach(v => {
                const meta = (v as any).metadata || {}
                output += `   - Variante: ${v.title} (SKU: ${v.sku || "N/A"})\n`
                if (meta.length_cm || meta.width_cm || meta.height_cm || meta.weight_kg) {
                    output += `     Dimensiones: ${meta.length_cm || "?"}L x ${meta.width_cm || "?"}W x ${meta.height_cm || "?"}H cm | Peso: ${meta.weight_kg || "?"}kg\n`
                } else {
                    output += `     ⚠️  SIN DIMENSIONES\n`
                }
            })
        }
        output += `\n`
    })

    const outputPath = path.join(process.cwd(), "..", "PRODUCTOS-LISTA.txt")
    fs.writeFileSync(outputPath, output, "utf8")
    console.log(`✅ Exportado a: ${outputPath}`)
    console.log(output.substring(0, 2000))
}
