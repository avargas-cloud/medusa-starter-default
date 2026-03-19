/**
 * src/modules/pos-user/service.ts
 * MedusaService auto-generates CRUD methods: createPosUsers, updatePosUsers, etc.
 */

import { MedusaService } from "@medusajs/utils"
import PosUser from './models/pos-user'

class PosUserModuleService extends MedusaService({
    PosUser,
}) { }

export default PosUserModuleService
