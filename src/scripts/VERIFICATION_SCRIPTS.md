# Scripts de Verificación - Guía Completa

## 🎯 Flujo de Uso

### Paso 1: Obtener IDs

**Listar Productos:**
```bash
npx medusa exec src/scripts/list-products-ids.ts
```

**Listar Categorías:**
```bash
npx medusa exec src/scripts/list-categories-ids.ts
```

### Paso 2: Copiar ID

Del output, copia el ID que te interesa. Ejemplo:
```
📦 100W Dimmable Power Supply for 12VDC LED Units
   ID: prod_100w-dimmable-power-supply-for-12vdc-led-units  ← COPIAR ESTO
   Handle: 100w-dimmable-power-supply-for-12vdc-led-units
```

### Paso 3: Editar Script de Verificación

**Para productos:**
Edita `src/scripts/verify-product-attrs.ts` línea 6:
```typescript
const productId = "prod_100w-dimmable-power-supply-for-12vdc-led-units"
```

**Para categorías:**
Edita `src/scripts/verify-category-filters.ts` línea 9:
```typescript
const categoryId = "pcat_led-strips-white"
```

### Paso 4: Ejecutar Verificación

```bash
npx medusa exec src/scripts/verify-product-attrs.ts
npx medusa exec src/scripts/verify-category-filters.ts
```

---

## 📋 Scripts Disponibles

| Script | Propósito | Output |
|--------|-----------|--------|
| `list-products-ids.ts` | Listar primeros 20 productos con IDs | Lista de productos |
| `list-categories-ids.ts` | Listar todas las categorías con IDs | Árbol de categorías |
| `verify-product-attrs.ts` | Ver atributos de UN producto | Lista "Título: Valor" |
| `verify-category-filters.ts` | Ver filtros de UNA categoría | JSON completo + lista legible |

---

## 💡 Ejemplo Completo

```bash
# 1. Ver qué productos hay
npx medusa exec src/scripts/list-products-ids.ts

# Output:
# 📦 100W Dimmable Power Supply for 12VDC LED Units
#    ID: prod_100w-dimmable-power-supply-for-12vdc-led-units
# ...

# 2. Editar verify-product-attrs.ts con ese ID

# 3. Ver sus atributos
npx medusa exec src/scripts/verify-product-attrs.ts

# Output:
# 🏷️  PRODUCT ATTRIBUTES:
# Power Consumption: 100W
# Voltage: 12VDC
# Dimmable: Yes
# ...
```

---

## ⚠️ Notas Importantes

1. **Sin cache**: Los scripts consultan la base de datos directamente
2. **Editar cada vez**: Debes editar el ID en el script antes de ejecutar
3. **IDs reales**: Solo funcionan con IDs que existan en la BD
4. **Case sensitive**: Los IDs distinguen mayúsculas/minúsculas

---

## 🔧 Para Desarrollo

Si necesitas verificar múltiples productos/categorías rápidamente, puedes:

1. Crear copias de los scripts con IDs diferentes
2. O modificar los scripts para aceptar argumentos (requiere más trabajo)
3. O usar el Admin UI directamente (puede tener cache)

**Estos scripts son para verificación cuando sospechas que hay diferencias entre lo que ves en el UI y lo que está en la BD.**
