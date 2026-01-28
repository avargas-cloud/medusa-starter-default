import { ContainerRegistrationKeys, Modules } from "@medusajs/framework/utils"

async function main() {
    console.log("QUERY:", ContainerRegistrationKeys.QUERY)
    console.log("REMOTE_QUERY:", ContainerRegistrationKeys.REMOTE_QUERY)
    console.log("PRODUCT:", Modules.PRODUCT)
}

main()
