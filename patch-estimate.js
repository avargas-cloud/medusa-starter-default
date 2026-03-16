const fs = require('fs');
const path = require('path');

const filePath = path.join(__dirname, 'src/api/admin/pos-discount/apply-existing/route.ts');
let content = fs.readFileSync(filePath, 'utf8');

// Fix import
content = content.replace(
  'import { posOverrideAdjustmentsWorkflow } from "../../../../workflows/pos-discount/workflows"',
  'import { posOverrideAdjustmentsWorkflow } from "../../../workflows/pos-discount/workflows"'
);

// Insert workflow call and comment out old SQL
const searchAnchor = 'logger.info(`[POS apply-existing] Applied ${promotion_code} via workflow`)';

const injection = `
        // ── Step 5 (NEW NATIVE): Override adjustments BEFORE confirmation ──────
        // Intercept the Draft Edit Payload and overwrite all the bad prorated numbers.
        await posOverrideAdjustmentsWorkflow(req.scope).run({
            input: {
                order_id,
                promotion_code,
                pct_discount: promoMethodValue && typeof promoMethodValue === 'number' ? promoMethodValue / 100 : null
            }
        })
        logger.info(\`[POS apply-existing] Ran posOverrideAdjustmentsWorkflow to patch JSON adjustments payload\`)

        /* --- LEGACY SQL FORCE LOGIC (Commented for fallback) ---
`;

if (content.includes(searchAnchor) && !content.includes('posOverrideAdjustmentsWorkflow(req.scope)')) {
    content = content.replace(searchAnchor, searchAnchor + '\n' + injection);
    
    // Close the comment block right before res.status(200)
    const endAnchor = 'res.status(200).json({ success: true })';
    content = content.replace(endAnchor, '        --------------------------------------------------------- */\n\n        ' + endAnchor);
}

fs.writeFileSync(filePath, content);
console.log('Patched apply-existing route successfully');
