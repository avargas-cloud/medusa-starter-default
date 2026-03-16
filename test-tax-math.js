const { Pool } = require("pg");
const { MathBN } = require("@medusajs/utils");

// Emulate calculateAmountsWithTax
function calculateTaxTotal({ isTaxInclusive = false, taxLines, taxableAmount, setTotalField }) {
    let taxTotal = MathBN.convert(0);
    for (const taxLine of taxLines) {
        const rate = MathBN.div(taxLine.rate, 100);
        let taxAmount = MathBN.mult(taxableAmount, rate);
        taxTotal = MathBN.add(taxTotal, taxAmount);
    }
    return taxTotal;
}

const itemPrice = 51.38;
const discount = 2.57;
const taxableBase = itemPrice - discount;
const taxTotal = calculateTaxTotal({
    taxLines: [{ rate: 7 }],
    taxableAmount: taxableBase
});
console.log("Medusa calculation for TaxableBase ($48.81) at 7% =", MathBN.convert(taxTotal).toNumber());

const origTaxTotal = calculateTaxTotal({
    taxLines: [{ rate: 7 }],
    taxableAmount: itemPrice
});
console.log("Medusa calculation for Original Price ($51.38) at 7% =", MathBN.convert(origTaxTotal).toNumber());
