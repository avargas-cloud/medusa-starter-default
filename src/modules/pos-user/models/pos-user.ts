/**
 * src/modules/pos-user/models/pos-user.ts
 * Data model for POS-only staff users.
 * These users can log in to the Store POS but NOT the Medusa Admin panel.
 * Authentication is handled by Medusa's auth module via actor_type "pos_user".
 */

import { model } from "@medusajs/utils"

const PosUser = model.define('pos_user', {
    id: model.id().primaryKey(),
    email: model.text(),
    first_name: model.text().nullable(),
    last_name: model.text().nullable(),
    can_view_accounting: model.boolean().default(false),
})

export default PosUser
