---
description: Protocolo obligatorio antes de reportar completitud
---

# Verify Before Completion Workflow

## Propósito
Este workflow es **OBLIGATORIO** antes de reportar cualquier tarea como completada al usuario.

## Steps

### 1. Crear Script de Verificación

Crear archivo en `src/scripts/verify-[nombre-feature].ts`:

```typescript
#!/usr/bin/env tsx
import dotenv from 'dotenv';
dotenv.config();

async function verifyFeature() {
  console.log('🔍 Verificando [Feature Name]\\n');
  
  try {
    // Test 1: Configuración
    console.log('📋 Test 1: ...');
    // lógica de verificación
    console.log('✅ Pasó\\n');
    
    // Test 2: Funcionalidad
    console.log('📋 Test 2: ...');
    // lógica de verificación
    console.log('✅ Pasó\\n');
    
    console.log('🎉 Todas las verificaciones pasaron!');
    process.exit(0);
  } catch (error) {
    console.error('❌ Verificación falló:', error);
    process.exit(1);
  }
}

verifyFeature();
```

### 2. Ejecutar Script de Verificación

// turbo
```bash
npx -y tsx src/scripts/verify-[nombre-feature].ts
```

### 3. Revisar Salida

- Si exit code = 0 → Continuar
- Si exit code = 1 → Corregir errores y volver al paso 2

### 4. (Opcional) Ejecutar Pre-Completion Check

// turbo
```bash
yarn run pre-complete
```

Este comando ejecuta:
- Verificación de sintaxis
- Type checking básico
- Validación de archivos críticos

### 5. Solo Entonces: Notificar Usuario

Usar `notify_user` con:
- Resumen de implementación
- Resultados de verificación
- Paths a archivos relevantes

## Anti-Patterns

❌ **NO hacer**:
- Reportar completitud sin ejecutar verificaciones
- Asumir que el código funciona
- Usar verificaciones manuales no repetibles

✅ **SÍ hacer**:
- Scripts automatizados
- Verificaciones con datos reales
- Reportar solo después de verificación exitosa
