## El Verdadero Problema y Solución

### Situación Actual

**DB:** Producto tiene solo `150W`  
**Frontend:** Modal carga y muestra `150W`

### Lo que DEBERÍA pasar cuando cambias 150W → 50W:

1. **Modal:** Quitas el badge de 150W (click en X)
2. **Modal:** Agregas 50W usando el dropdown + "Add"
3. **Save:** Envía `value_ids = [todos los atributos MENOS 150W, MÁS 50W]`
4. **Workflow:**
   - `currentIds` (DB) = [150W, otros 36]
   - `valueIds` (nuevo) = [50W, otros 36]
   - `toDismiss` = [150W] ← Elimina 150W
   - `toCreate` = [50W] ← Crea 50W
5. **Resultado:** Producto queda con solo 50W ✅

### Lo que ESTÁ PASANDO:

1. **Modal:** Usuario cambia dropdown de 150W a 50W
2. **Modal:** Click en "+ Add"
3. **BUG:** El sistema AGREGA 50W sin quitar 150W
4. **Save:** Envía `value_ids = [150W, 50W, otros 36]`
5. **Workflow:**
   - `currentIds` (DB) = [150W, otros 36]
   - `valueIds` (nuevo) = [150W, 50W, otros 36]
   - `toDismiss` = [] ← VACÍO, porque 150W sigue en la lista
   - `toCreate` = [50W]
6. **Resultado:** Producto tiene 150W Y 50W ❌

### LA SOLUCIÓN

**El frontend NO debe usar dropdown para cambiar valores existentes.**

En su lugar:

1. **Para CAMBIAR un valor:** Click en X para quitarlo, luego "+ Add" para agregar el nuevo
2. **Para AGREGAR múltiples valores:** Solo "+ Add" (sin quitar nada)

**O implementar lógica en el dropdown que auto-quite el valor viejo cuando seleccionas uno nuevo del MISMO attribute_key**

---

## Fix Propuesto

Modificar `handleAddNew` para que:
- SI ya existe un valor para ese `attribute_key` en badges
- Y estás agregando un valor DIFERENTE del mismo key  
- ENTONCES automáticamente quita el viejo antes de agregar el nuevo

Esto hace que el comportamiento sea: "Cambiar" en lugar de "Agregar"
