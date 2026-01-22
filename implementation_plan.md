
# Plan de Implementación: Mejoras Widget de Atributos v2 (Refinado)

## 1. UX: Agrupación y Badges (Aprobado con Mejoras)
**Cambio:** Refactorizar la tabla visual.
*   **Antes:** 1 Fila por cada Valor (ej: 3 filas para 3 colores).
*   **Ahora:** 1 Fila por Key.
    *   **Columna Atributo:** Nombre del Key (ej: "Color").
    *   **Columna Valor:** Lista de Badges `[Rojo x] [Azul x]`.
    *   **Acción:** Eliminar la fila completa (Borra todos los valores de esa key).
    *   **Eliminar Individual:** Clic en la "x" del Badge.

## 2. Lógica: Toggle "Variación" y Metadata
**Estrategia:** `product.metadata.variant_attributes` = Array de IDs de Keys.
**Regla de Oro:** Siempre enviar el array completo recalculado.
**Sincronización:**
*   Al guardar, calcular qué Keys tienen el toggle "Variant" activado.
*   Si una Key NO tiene valores asignados, eliminarla de la lista de variaciones (limpieza automática).

## 3. UI: Scroll y Layout
**Decisión:** Mantener `FocusModal` pero corregir layout.
*   **Header:** Fijo.
*   **Body:** `overflow-y-auto`.
*   **Footer:** (Opcional, el botón Save está en header).

## 4. Flujo de Guardado (`handleSave`)
El botón "Save" ejecutará dos acciones paralelas o secuenciales:
1.  **Update Product (Metadata):** Enviar `variant_attributes` (IDs únicos).
2.  **Update Attributes (Links):** Enviar lista plana de Value IDs.
   *   *Nota:* Necesitaremos actualizar la ruta API o el Workflow para aceptar ambos, o hacer 2 llamadas fetch.
   *   *Decisión:* Para robustez, haremos **2 llamadas** desde el frontend por ahora, o idealmente actualizamos el POST endpoint para hacer todo en un workflow atómico.
   *   *Mejor:* Actualizar el Endpoint POST para recibir `{ valueIds, variantKeys }` y que el backend maneje el workflow.

---

## Ejecución Técnica

1.  **Backend (API & Workflow):**
    *   Modificar `update-product-attributes.ts` para recibir `variantKeys`.
    *   Agregar paso `updateProductMetadataStep`.
    *   Actualizar `route.ts` para pasar `variant_keys` del body al workflow.

2.  **Frontend (Modal):**
    *   Estado local: `tempAttributes` (Plano).
    *   Calculado: `groupedAttributes` (Agrupado por Key ID para renderizar tabla).
    *   Estado local: `variantFlags` (Mapa `KeyID -> Boolean`).
    *   Render: Tabla iterando sobre `groupedAttributes`.
    *   Save: Construir payloads y llamar API.

