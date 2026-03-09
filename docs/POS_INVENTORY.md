# POS_INVENTORY — Inventario

| Campo | Detalle |
|-------|---------|
| **Módulo** | Inventory |
| **Ruta POS** | `/inventory` |
| **Search** | MeiliSearch (`inventory` index) |
| **Backend** | Medusa v2 Inventory Module |
| **Última revisión** | 2026-03-07 |

---

## Descripción

El módulo de Inventory permite al staff consultar niveles de stock por producto y por ubicación (warehouse/location), así como buscar items rápidamente en el POS para agregarlos a las órdenes. Usa MeiliSearch para búsqueda en tiempo real de ítems y precios ("Gold Standard"), y el Medusa Inventory Module para el detalle de stock levels por ubicación.

---

## Búsqueda de Productos (Item Search)

En el POS (`ItemSearch.tsx`), la búsqueda avanzada de ítems **no utiliza** el índice tradicional de productos. En su lugar, consulta el índice **`inventory`** en MeiliSearch.

Este enfoque representa un "Gold Standard" porque el índice `inventory` contiene una estructura plana (flattened) donde cada variante de producto es un documento independiente pre-calculado. Esto evita lógicas complejas de mapeo en el frontend y reduce los tiempos de respuesta.

```typescript
// MeiliSearch index: inventory
// Estructura de documento (ProductHit):
{
  id: string,
  title: string,
  thumbnail: string | null,
  sku: string,
  price: number,             // Precio base (retail)
  currencyCode: string,
  pricesByList: Record<string, number>, // Precios por Customer Group / Price Level
  variantId: string,
  productId: string
}
// Campos buscables principales: title, sku
```

Al seleccionar un ítem de la búsqueda, el POS determina el precio correcto evaluando instantáneamente el `Price Level` del cliente asignado a la orden contra el objeto `pricesByList` del resultado de búsqueda provisto por MeiliSearch.

---

## Lista de Inventario (`/inventory`)

- Búsqueda por SKU, nombre de producto, barcode
- Filtros: ubicación, nivel de stock (en stock / bajo stock / agotado)
- Columnas: SKU, Producto, Variante, Ubicación, Stock

---

## Stock por Ubicación

Medusa v2 soporta múltiples `inventory_locations`. El POS muestra el stock disponible por cada ubicación configurada obteniendo los datos en tiempo real de Medusa para asegurar precisión absoluta:

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

El inventario usa MeiliSearch como fuente primaria para búsqueda (baja latencia y datos "flattened"), con Medusa como fuente de verdad para el detalle granular de stock por location.

```
Búsqueda por nombre/SKU (con precios) → MeiliSearch (index: inventory) (< 50ms)
Niveles de stock granulares por loc   → Medusa API   (real-time)
```

Los ítems en MeiliSearch se mantienen sincronizados automáticamente a través de los workflows y subscribers de Medusa, asegurando que cuando cambian los precios (ej. por eventos locales) o se agregan items, el índice `inventory` refleje la realidad. Alternativamente, tenemos `sync-meili-inventory.ts` para disparar el flujo del worker hacia MeiliSearch.

---

## Edición de Ítems (`ItemDetailModal`)

El POS permite editar propiedades físicas y comerciales de los ítems directamente desde la grilla de inventario. Debido a la arquitectura separada de Medusa v2, los datos a editar provienen de dos entidades distintas en la base de datos:

1. **Inventory Item:** Contiene la data logística estricta (`sku`, `title`, `weight`, `length`, `width`, `height`, `hs_code`, `mid_code`, `material`).
2. **Product (Metadata):** Contiene la data comercial que no es nativa de Medusa, manejada vía `metadata` (`sales_description`, `mpn`, `vendor`).

### Estrategia de Fetching y Guardado

- Al abrir el modal, realiza dos queries en paralelo:
  - `GET /admin/inventory-items/:id` (para dimensiones y atributos aduaneros).
  - `GET /admin/products/:productId?fields=+metadata` (para popular MPN, Vendor, y Sales Description).
- **Dimensiones de Envío:** Las dimensiones ingresadas aquí (`weight`, `length`, `width`, `height`) son la **fuente primaria** de cálculo para nuestro cotizador de UPS en el checkout y en el POS (`ups-ground-shipping/service.ts`), superando a las dimensiones del `Variant`.
- **Validación de Guardado (`isDirty`):** El botón "Save Changes" permanece estrictamente deshabilitado hasta que el usuario modifique al menos un campo real, evitando peticiones API innecesarias.
- Al guardar, emite dos peticiones `POST` paralelas a los endpoints correspondientes de Inventario y Producto, garantizando que el `metadata` del producto central se mantenga sincronizado. Se omiten atributos del nivel `Variant` (como `barcode` y `country_of_origin`) de este payload para prevenir errores HTTP 400.

---

## Known Issues (Revisado)

| Issue | Fix |
|-------|-----|
| Ítem no aparece con precio actualizado en ItemSearch | Ejecutar `npm run sync:inventory` o invocar su archivo interno `backend/src/scripts/sync/sync-meili-inventory.ts` para regenerar el índice `inventory` en MeiliSearch. |
| Stock detallado no coincide con Medusa Admin | El display granular de stock location viene de Medusa en tiempo real — fallos aquí sugieren problemas de red o sesión expirada. El ItemSearch hace request de stock tras cargar los resultados. |
| Múltiples variantes con mismo SKU | El índice `inventory` requiere que el SKU sea único por variante para relacionar correctamente los items y precios. |
