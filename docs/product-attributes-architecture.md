# Especificación Técnica & Manual de Rescate: Atributos de Producto (v2.1)

> [!WARNING]
> **LEER ANTES DE TOCAR:** Este módulo utiliza una implementación personalizada ("Nuclear Option") para superar limitaciones del Link Service de Medusa v2. No ejecutar `db:migrate` ciegamente sin entender la sección de "Persistencia Manual".

## 1. Arquitectura "Nuclear" (La Solución)

Debido a un bug persistente en Medusa v2 que forzaba relaciones 1:1 en los Remote Links, implementamos una solución híbrida robusta.

### A. Base de Datos (SQL Manual)
No confiamos en la migración automática de Medusa para la tabla de links.
La tabla `product_product_productattributes_attribute_value` fue creada/parcheada manualmente para imponer una restricción `UNIQUE (product_id, attribute_value_id)` en lugar de `UNIQUE (product_id)`.

*   **Tabla Real:** `product_product_productattributes_attribute_value`
*   **Constraint Crítico:** `UNIQUE ("product_id", "attribute_value_id")`
*   **Script de Rescate:** `src/scripts/force-create-link-table.js` (Ejecutar esto si la tabla desaparece o se corrompe).

### B. Workflow Atómico (Backend)
Para garantizar consistencia, no guardamos links y metadata por separado. Usamos un workflow unificado.

*   **Archivo:** `src/workflows/product-attributes/update-product-attributes.ts`
*   **Entrada:**
    ```typescript
    {
      productId: string,
      valueIds: string[],      // IDs de los valores (Links)
      variantKeys: string[]    // IDs de los Keys que son Switches (Metadata)
    }
    ```
*   **Lógica:**
    1.  `update-links`: Sincroniza los links.
    2.  `update-product-metadata`: Actualiza `product.metadata.variant_attributes`.

### C. Widget Atómico (Frontend)
El Widget (`product-attributes-widget.tsx`) agrupa visualmente los atributos y envía un **payload único** al guardar.

*   **Endpoint:** `POST /admin/products/[id]/attributes`
*   **Payload:** `{ value_ids: [...], variant_keys: [...] }`
*   **Visualización:** Agrupa por `AttributeKey`. Si un atributo se marca como "Variant", el frontend lo sabe leyendo `product.metadata`.

---

## 2. Manual de Rescate (Troubleshooting)

### Escenario A: "Los atributos desaparecieron del Admin"
**Diagnóstico:** Probablemente la base de datos se reinició o Medusa intentó una migración automática que borró la tabla.

**Solución 1 (Verificación):**
Ejecuta el script de auditoría:
```bash
npx medusa exec ./src/scripts/verify-db-count.ts
```
*   Si dice `0 links`, la data se borró.
*   Si dice `N links` pero no se ven, falla la API (ver Escenario B).

**Solución 2 (Reconstrucción de Tabla):**
Si la tabla da error de "Relation does not exist":
```bash
node src/scripts/force-create-link-table.js
```
Esto recreará la tabla con la estructura correcta (1:N permisiva).

**Solución 3 (Repoblar Datos):**
Si tienes los datos en JSON original (WooCommerce):
```bash
npx medusa exec ./src/scripts/migrate-product-attributes.ts
```
Este script usa inyección SQL directa para saltarse bloqueos de aplicación.

---

### Escenario B: "Error al Guardar" (Toast Rojo)

**Verificar:**
1.  Revisar logs de terminal. ¿Dice `Duplicate key value violates unique constraint`?
    *   Significa que intentas guardar lo mismo dos veces. (No debería pasar con el UI actual).
2.  Revisar `update-product-attributes.ts`. Asegurar que los pasos están exportados y registrados.

---

### Escenario C: "Vuelven a ser solo 1 por producto"

**Diagnóstico:** Medusa v2 regeneró la migración automática y sobreescribió nuestra tabla manual.

**Solución:**
1.  Ejecutar `src/scripts/drop-link-table.js` (Limpieza).
2.  Ejecutar `src/scripts/force-create-link-table.js` (Reconstrucción Nuclear).
3.  Ejecutar migración de datos de nuevo.

---

## 3. Referencia de Archivos Críticos

| Archivo | Propósito | Nivel de Riesgo |
|---------|-----------|-----------------|
| `src/scripts/force-create-link-table.js` | Crea la tabla SQL raw | 🔴 Alto (DANGER) |
| `src/scripts/migrate-product-attributes.ts` | Inserta datos masivos vía SQL | 🟠 Medio |
| `src/workflows/product-attributes/update-product-attributes.ts` | Lógica de negocio (Links + Meta) | 🟢 Seguro |
| `src/admin/widgets/product-attributes-widget.tsx` | UI Principal | 🟢 Seguro |

**Generado:** 22 Enero 2026 - Sesión de Reparación de Arquitectura.
