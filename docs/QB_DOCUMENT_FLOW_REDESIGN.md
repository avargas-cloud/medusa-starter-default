# QB Document Flow Redesign — Plan

## Objetivo
Reducir documentos QB innecesarios y eliminar race conditions en el flujo POS → QuickBooks.

## Problema actual
Flujo actual siempre crea: Estimate → Sales Order → Invoice (3 docs, 3 Web Connector requests, múltiples puntos de falla por timing).

## Nueva lógica (árbol de decisión)

Disparador: `pos.invoice.created`

```
¿Order tiene < 1 hora? (created_at vs now)
│
├── SÍ →
│   ├── Fulfillment completo (invoice.total == order.total)?
│   │   ├── SÍ + pago capturado (payment_status = "captured") → Sales Receipt QB
│   │   ├── SÍ + crédito/pago pendiente                       → Invoice QB directo
│   │   └── NO (fulfillment parcial)                          → Invoice QB directo
│   └── En todos los casos: guardar qb_skip_so=true (el cron NO crea SO)
│
└── NO (>= 1 hora) →
    ├── qb_sales_order_txn_id existe → Invoice QB linkado al SO
    └── qb_sales_order_txn_id NO existe → qb_invoice_pending=true (cron retry)
```

## Señales de detección
| Condición | Campo |
|---|---|
| Edad de la orden | `order.created_at` vs `Date.now()` |
| Fulfillment completo | `invoice.total == order.total` |
| Crédito / pago pendiente | `payment_status !== "captured"` al momento del invoice |
| SO existe en QB | `metadata.qb_sales_order_txn_id` |

## Nuevo flag de metadata
- `qb_skip_so: true` — orden procesada directamente (< 1hr), cron debe skippear creación de SO

## Archivos a modificar
1. `src/lib/quickbooks/handlers/handle-fulfillment-created.ts` — lógica principal del árbol
2. `src/jobs/qb-pos-sync.ts` — skip orders con `qb_skip_so: true`
3. `src/lib/quickbooks/handlers/handle-order-placed.ts` — si `qb_estimate_txn_id` ya existe, no delay de 1hr

## Pendiente verificar antes de implementar
- ¿Cómo se detecta "crédito usado"? ¿Es `payment_status !== "captured"` en Medusa o hay otro campo?
- Ver el handler actual de `pos.invoice.created` para entender el flujo de invoice existente
- Confirmar estructura de `pos.invoice.created` payload

## Estado
- [ ] Verificar detección de crédito y ver handler actual de invoice
- [ ] Implementar árbol en handle-fulfillment-created
- [ ] Agregar skip en cron
- [ ] Remover delay de 1hr en handle-order-placed cuando QB estimate ya existe
- [ ] Probar localmente
- [ ] Commit y push
