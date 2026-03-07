# POS_INVENTORY — Inventario

| Campo | Detalle |
|-------|---------|
| **Módulo** | Inventory |
| **Ruta POS** | `/inventory` |
| **Search** | MeiliSearch (`products` index) |
| **Backend** | Medusa v2 Inventory Module |
| **Última revisión** | 2026-03-06 |

---

## Descripción

El módulo de Inventory permite al staff consultar niveles de stock por producto y por ubicación (warehouse/location). Usa MeiliSearch para búsqueda en tiempo real y el Medusa Inventory Module para stock levels.

---

## Búsqueda de Productos

```typescript
// MeiliSearch index: products
// Campos buscables: title, handle, sku, barcode, variants.sku
// Filtros: status (published/draft), inventory_quantity
```

---

## Lista de Inventario (`/inventory`)

- Búsqueda por SKU, nombre de producto, barcode
- Filtros: ubicación, nivel de stock (en stock / bajo stock / agotado)
- Columnas: SKU, Producto, Variante, Ubicación, Stock

---

## Stock por Ubicación

Medusa v2 soporta múltiples `inventory_locations`. El POS muestra el stock disponible por cada ubicación configurada:

```
Product: EcoPower Solar Panel 300W (SKU: SP-300W)
│
├── Warehouse A    →  45 units
├── Warehouse B    →   8 units (⚠️ bajo stock)
└── Floor/Display  →   2 units
```

---

## Endpoints Relevantes

```
GET /admin/inventory-items                 Lista items de inventario
GET /admin/inventory-items/:id/location-levels  Stock por ubicación
GET /admin/stock-locations                 Lista de ubicaciones

POST /admin/inventory-items/:id/location-levels  Ajuste manual de stock
```

---

## Ajuste de Inventario

El POS permite ajustes manuales de stock (recepción de mercancía, ajustes de conteo):

```typescript
// Ajustar stock en una ubicación:
POST /admin/inventory-items/:id/location-levels
{
  location_id: "sloc_01XXX",
  stocked_quantity: 50
}
```

---

## MeiliSearch — Estrategia

El inventario usa MeiliSearch como fuente primaria para búsqueda (velocidad), con Medusa como fuente de verdad para datos de stock.

```
Búsqueda por nombre/SKU → MeiliSearch  (< 50ms)
Stock levels actuales   → Medusa API   (real-time)
```

Los productos en MeiliSearch se re-indexan cuando:
- Se publica/actualiza un producto en Medusa Admin
- Se llama `POST /admin/meilisearch/reindex` manualmente

---

## Known Issues

| Issue | Fix |
|-------|-----|
| Producto no aparece en búsqueda | Re-indexar MeiliSearch: `POST /admin/meilisearch/reindex` |
| Stock no coincide con Medusa Admin | El display de stock viene de Medusa en tiempo real — verificar `inventory_quantity` en la variante |
| Múltiples variantes con mismo SKU | SKU debe ser único por variante en Medusa |
