import FinanceModuleService from './service'
import { Module } from '@medusajs/framework/utils'

export const FINANCE_MODULE = 'finance'

export default Module(FINANCE_MODULE, {
    service: FinanceModuleService,
})
