import * as coreFlows from "@medusajs/core-flows";
const keys = Object.keys(coreFlows).filter(k => k.toLowerCase().includes('shipment') || k.toLowerCase().includes('deliver'));
console.log(keys);
