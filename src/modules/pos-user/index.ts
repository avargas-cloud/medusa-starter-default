/**
 * src/modules/pos-user/index.ts
 * Module definition — register in medusa-config.ts as resolve: "./src/modules/pos-user"
 */

import { Module } from '@medusajs/framework/utils'
import PosUserModuleService from './service'

export const POS_USER_MODULE = 'pos_user'

export default Module(POS_USER_MODULE, {
    service: PosUserModuleService,
})
