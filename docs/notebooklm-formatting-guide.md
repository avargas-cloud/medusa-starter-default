# Guía para Consultas a NotebookLM (Tutor)

## Regla Fundamental

**NotebookLM tiene límite de ~1,500 caracteres en el chat.**

Debes enviar mensajes ULTRA RESUMIDOS que vayan directo al punto.

## Límites Críticos

| Elemento | Límite | Consecuencia si excedes |
|----------|--------|-------------------------|
| Chat input | ~1,500 caracteres | Botón de enviar se deshabilita (gris) |
| Caracteres aprox | ~250 palabras | No puedes enviar |

## Reglas de Formato

### 1. SIN Bloques de Código

❌ INCORRECTO:
```
\`\`\`typescript
const x = "code"
\`\`\`
```

✅ CORRECTO:
```
Code: const x = "code"
```

### 2. SIN HTML/JSX

❌ INCORRECTO: `<div className="x">`

✅ CORRECTO: `div con className x`

### 3. SIN Nombres de Archivo Pegados

❌ INCORRECTO: `route.tsEl código hace...`

✅ CORRECTO: 
```
File: route.ts
El código hace...
```

### 4. Usa Texto Plano Simple

- Sin markdown complejo
- Sin emojis
- Separadores simples (===== o -----)
- Saltos de línea claros

## Plantilla Obligatoria (Máximo 1,500 caracteres)

```
[TEMA] - [CONTEXTO BREVE]

BUG 1: [NOMBRE]
[Descripción en 2-3 líneas]
Question: [Pregunta específica]

BUG 2: [NOMBRE]
[Descripción en 2-3 líneas]
Questions:
- [Pregunta 1]
- [Pregunta 2]

BUG 3: [NOMBRE]
[Descripción en 2-3 líneas]
Question: [Pregunta específica]

Context: [Stack y versión]
```

## Ejemplo Real (949 caracteres)

```
Medusa v2 Dynamic Variants - 3 Bugs

BUG 1: Orphaned Variants
When we call productService.deleteProductOptions([optionId]), the option deletes but variants remain orphaned.
Question: How to delete variants before deleting their parent option in Medusa v2?

BUG 2: Subscriber Not Executing
Created src/subscribers/protect-managed-options.ts to block manual option deletion.
Has: export default function, export const config
Event: ${Modules.PRODUCT}.product_option.deleted
Problem: Subscriber never executes, no logs appear.
Questions: 
- Correct event name format?
- How to verify Medusa registered it?

BUG 3: Widget No Refresh
After save, widget shows old data until F5.
Using: queryClient.invalidateQueries({ queryKey: [["product", id, "custom-attributes"]] })
Question: Correct query key format for Medusa v2 admin widgets?

Context: Medusa v2, React Query, TypeScript. Variant generation works perfectly. Need these 3 Medusa-specific patterns.
```

## Proceso de Reducción

Si tu mensaje es muy largo:

### 1. Elimina Contexto Innecesario

❌ NO incluyas:
- Historia completa del problema
- Todo el código
- Todos los intentos previos
- Explicaciones largas

✅ SÍ incluye:
- Solo el problema actual
- Pregunta específica
- Mínimo contexto necesario

### 2. Resume Cada Bug a 3-4 Líneas

Formato:
```
[Qué pasa mal en 1 línea]
[Qué estás haciendo en 1 línea]
[Pregunta específica en 1 línea]
```

### 3. Prioriza Bugs

Si tienes 5 bugs, envía solo los 3 más críticos primero.

## Comandos Útiles

```bash
# Verificar tamaño ANTES de enviar
wc -c archivo.txt

# Objetivo: Menos de 1,500
# Ejemplo: 949 archivo.txt ✅ BIEN
# Ejemplo: 6,750 archivo.txt ❌ MUY LARGO

# Contar palabras (orientativo)
wc -w archivo.txt
# Objetivo: Menos de 250 palabras
```

## Checklist Pre-Envío

Antes de pegar en NotebookLM:

- [ ] Menos de 1,500 caracteres (`wc -c archivo.txt`)
- [ ] Sin bloques de código (```)
- [ ] Sin HTML/JSX suelto
- [ ] Nombres de archivo tienen espacios claros
- [ ] Solo texto plano
- [ ] Preguntas específicas, no genéricas
- [ ] Eliminaste todo el contexto innecesario

## Estrategia: Multiple Messages

Si necesitas más detalle:

1. **Mensaje 1** (1,500 chars): Pregunta los 3 bugs principales
2. **Espera respuesta** del tutor
3. **Mensaje 2** (1,500 chars): Profundiza en el bug más crítico
4. **Mensaje 3** (1,500 chars): Pregunta sobre implementación específica

**No intentes poner TODO en un mensaje.**

## Errores Comunes

### Error 1: Botón Gris (Deshabilitado)

**Causa**: Texto > 1,500 caracteres

**Solución**:
1. Copia tu texto a archivo
2. `wc -c archivo.txt`
3. Si >1,500: Resume drásticamente
4. Elimina 50% del contenido
5. Verifica de nuevo

### Error 2: Querer Explicar Todo

**Causa**: Intentas dar contexto completo

**Solución**: El tutor es experto en Medusa. Solo pregunta lo específico.

Ejemplo:

❌ MAL (demasiado contexto):
```
Estamos implementando dynamic variants en Medusa v2. La arquitectura fue validada previamente. Tenemos Remote Query funcionando. El Pricing Module está integrado. Todo funciona excepto que cuando eliminamos...
```

✅ BIEN (directo):
```
Medusa v2: When deleting option, variants stay orphaned. How to delete variants with their parent option?
```

### Error 3: Copiar Código Completo

**Causa**: Pegas 50 líneas de código

**Solución**: Describe el código en 1-2 líneas

❌ MAL:
```
async function handler() {
  const product = await productService.get(id)
  const options = product.options
  // ... 40 líneas más
}
```

✅ BIEN:
```
Function calls productService.deleteProductOptions([id]) but variants remain.
```

## Regla de Oro

**Cada palabra cuenta. Elimina TODO lo que no sea absolutamente necesario para entender la pregunta.**

Si puedes decir lo mismo en menos palabras, hazlo.

## Ejemplo: Antes vs Después

### ANTES (17,312 caracteres - BLOQUEADO)

```
MEDUSA V2 DYNAMIC VARIANTS - COMPREHENSIVE STATUS REPORT

EXECUTIVE SUMMARY
We have successfully implemented 90% of the dynamic variants feature...

PART 1: WHAT IS WORKING
1. Variant Generation (100% functional)
When a user enables an attribute as variant...
[... 500 líneas más ...]
```

### DESPUÉS (949 caracteres - FUNCIONA)

```
Medusa v2 Dynamic Variants - 3 Bugs

BUG 1: Orphaned Variants
deleteProductOptions([id]) leaves orphaned variants.
Q: How to delete variants with parent option?

BUG 2: Subscriber Not Executing
Event: ${Modules.PRODUCT}.product_option.deleted
Never executes, no logs.
Q: Correct event name?

BUG 3: Widget No Refresh
invalidateQueries not working until F5.
Q: Correct query key format?

Stack: Medusa v2, React Query
```

**Reducción: 95% menos texto, misma información crítica.**

## Conclusión

**NotebookLM = Mensajes cortos y directos**

- Máximo 1,500 caracteres
- Solo lo esencial
- Preguntas específicas
- Sin código largo
- Sin contexto innecesario

Si tienes más que decir, envía múltiples mensajes separados.

---

**Última actualización**: 2026-01-24  
**Mantenedor**: Equipo de desarrollo
