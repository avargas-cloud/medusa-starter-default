import { MedusaContainer } from "@medusajs/medusa"

export default async function ({ container }: { container: MedusaContainer }) {
    console.log("CONTAINER KEYS:")
    console.log(container.registrations ? Object.keys(container.registrations).join(", ") : "No registrations property")
}
