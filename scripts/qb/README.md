# QB Test Scripts (Remote)

Scripts para probar la integración Medusa ↔ QuickBooks vía el QB Bridge remoto.
Son la versión "desde Mac/Linux" de los scripts del `quickbooks-bridge/scripts/`.

## Setup rápido

Asegúrate de tener en `backend/.env`:
```env
QB_BRIDGE_URL=https://ecopower-qb.loca.lt
QB_API_KEY=mQb-7k9Pzx4RwN2vL8jT3bY6hF5nC1aD
```

## Cómo correr

```bash
cd backend   # SIEMPRE desde el directorio backend/
npx ts-node --project tsconfig.json scripts/qb/<script>.ts
```

## Scripts

| Script | Descripción | Cuándo usarlo |
|--------|-------------|---------------|
| `test-health.ts` | Ping al bridge | Primero — verificar conexión |
| `test-customer.ts` | Crear + leer cliente en QB | Verificar que QB acepta escrituras |
| `test-sales-order.ts` | Crear un Sales Order | Probar creación de órdenes |
| `test-prepayment-flow.ts` | Flujo completo: SO → Payment → Invoice → Apply | E2E del flow de e-commerce |
| `test-estimate-flow.ts` | Estimate → Sales Order conversion | Flujo de Draft Orders (B2B) |
| `check-operation.ts <opId>` | Ver el status de un operationId | Debug de operaciones |

## Secuencia de prueba recomendada

```bash
# 1. Verificar que el bridge responde
npx ts-node --project tsconfig.json scripts/qb/test-health.ts

# 2. Verificar escritura de clientes
npx ts-node --project tsconfig.json scripts/qb/test-customer.ts

# 3. Crear un Sales Order simple
npx ts-node --project tsconfig.json scripts/qb/test-sales-order.ts

# 4. Flujo completo e-commerce
npx ts-node --project tsconfig.json scripts/qb/test-prepayment-flow.ts
```

## Override de IDs por CLI

Puedes sobreescribir los ListIDs de QB sin editar el archivo:

```bash
QB_TEST_CUSTOMER=8000XXXX-XXXXXXXX \
QB_TEST_PRODUCT=800019EA-1715274093 \
npx ts-node --project tsconfig.json scripts/qb/test-sales-order.ts
```

## Nota sobre los ListIDs

Los valores default en `config.ts` son:
- **Customer**: EPT Alejandro Vargas (`8000004E-1342117388`)
- **Product**: EAP-AS1-8S (`800019EA-1715274093`)
- **Site**: Principal Warehouse (`80000001-1331053531`)

Actualiza `config.ts` con tus IDs actuales si es necesario.
