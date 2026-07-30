# QuickBooks Sync Scripts

## 📋 Scripts Disponibles

### 1. `sync-qb-inventory.ts` (COMPLETO)
Sincroniza **stock Y precios** juntos.

```bash
yarn medusa exec ./src/scripts/sync-qb-inventory.ts
```

**Cuándo usar**: Sincronización inicial o completa (primera vez).

---

### 2. `sync-qb-prices.ts` (SOLO PRECIOS) ⭐
Sincroniza **SOLO precios** desde QuickBooks.

```bash
yarn medusa exec ./src/scripts/sync-qb-prices.ts
```

**Cuándo usar**: 
- 🕐 **1x por día** (noche, ej: 2:00 AM)
- Después de actualización masiva de precios en QB
- Los precios cambian raramente

**Ventajas**:
- Más rápido que sync completo
- No toca inventario
- Menos logs, más legible
- **Compara antes de actualizar** (solo escribe si cambió)

---

### 3. `sync-qb-stock.ts` (SOLO STOCK) ⭐⭐
Sincroniza **SOLO cantidades** desde QuickBooks.

```bash
yarn medusa exec ./src/scripts/sync-qb-stock.ts
```

**Cuándo usar**:
- ⏰ **Frecuentemente** (cada 15-30 mins)
- Stock cambia constantemente
- Necesitas inventario actualizado

**Ventajas**:
- Mismo tiempo que sync completo (~2-3 mins por Web Connector)
- No toca precios
- Logs enfocados en stock
- **Compara antes de actualizar** (solo escribe si cambió)

---

## 🎯 Optimización: Skip Unchanged Values

**Ambos scripts (`sync-qb-prices.ts` y `sync-qb-stock.ts`) comparan valores antes de actualizar:**

```typescript
// PRECIOS: Compara precio actual en cents
const currentAmount = await getCurrentPrice(variant)
if (currentAmount === newAmountInCents) {
    skip()  // No actualizar si es igual
}

// STOCK: Compara cantidad actual
const currentStock = await getCurrentStock(inventoryItem)
if (currentStock === newStock) {
    skip()  // No actualizar si es igual
}
```

**Beneficios**:
- ✅ Reduce puntos de fallo (menos escrituras = menos riesgo)
- ✅ Ahorra recursos (menos UPDATEs en DB)
- ✅ Reportes más claros (`Skipped (Unchanged): X` en resumen)

**Performance**:
- 1ra ejecución: 0 skips, 412 updates
- Ejecuciones subsecuentes (sin cambios): ~400+ skips, ~5-10 updates
- Resultado: De 412 UPDATEs → 5-10 UPDATEs por sync regular

---

## ⚙️ Configuración (Todos los Scripts)

Todos usan las mismas variables:

```typescript
const BRIDGE_URL = "https://ecopower-qb.loca.lt"  // Tu túnel localtunnel
const API_KEY = "$QB_API_KEY"
const POLL_INTERVAL_MS = 30000  // 30 segundos
const MAX_POLL_ATTEMPTS = 20    // 10 mins máximo
```

---

## 🔄 Flujo de Sincronización

1. **Consulta Medusa**: Obtiene variants con `quickbooks_id`
2. **Solicita a QB Bridge**: POST `/api/products` → devuelve `operationId`
3. **Polling cada 30s**: GET `/api/sync/status/{operationId}`
4. **Espera Web Connector**: ~2 minutos (QB Desktop sincroniza cada 2 mins)
5. **Procesa datos**: Actualiza Medusa (precios o stock según script)

**Tiempo total**: ~2-4 minutos (cuello de botella: Web Connector)

---

## 📊 Performance

| Script | Tiempo | Frecuencia Recomendada |
|--------|--------|------------------------|
| `sync-qb-inventory.ts` | ~3 mins | Inicial / Completa |
| `sync-qb-prices.ts` | ~3 mins | 1x día (noche) |
| `sync-qb-stock.ts` | ~3 mins | Cada 15-30 mins |

*Nota: El tiempo es similar porque el cuello de botella es QuickBooks, no Medusa.*

---

## 🚨 Troubleshooting

**Script se queda en "Polling Status":**
- Verifica que QuickBooks esté abierto en el servidor Windows
- Verifica que Web Connector esté corriendo
- Verifica túnel localtunnel: `https://ecopower-qb.loca.lt/health`

**"No linked products found":**
- Ejecuta primero: `yarn medusa exec ./src/scripts/assign-quickbooks-ids.ts`

**"No Stock Location found":**
- Crea un Stock Location en Medusa Admin Settings

---

## ✨ Ejemplo de Cron Jobs

```bash
# Precios: 1x día a las 2 AM
0 2 * * * cd /path/to/medusa && yarn medusa exec ./src/scripts/sync-qb-prices.ts

# Stock: Cada 30 mins (8 AM - 8 PM)
*/30 8-20 * * * cd /path/to/medusa && yarn medusa exec ./src/scripts/sync-qb-stock.ts
```

---

**Última actualización**: 27 Enero 2026
