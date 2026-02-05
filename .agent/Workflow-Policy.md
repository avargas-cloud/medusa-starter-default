# 🔄 Agent Workflow Policy

## Mandatory Implementation Workflow

Para **TODA** implementación, seguir este orden estrictamente:

### 1. 📋 Planning Phase
- [ ] Crear `implementation_plan.md` con detalles técnicos
- [ ] Obtener aprobación del usuario
- [ ] Actualizar `task.md` con checklist

### 2. 🔧 Implementation Phase
- [ ] Modificar/crear archivos de código
- [ ] Aplicar cambios según el plan

### 3. ✨ Verification Script Creation Phase ⚠️ OBLIGATORIO
- [ ] **Crear script de verificación en `/src/scripts/verify-[feature].ts`**
- [ ] El script debe:
  - Importar y probar la funcionalidad implementada
  - Hacer verificaciones reales (queries a DB, llamadas a funciones, etc.)
  - Reportar claramente éxitos y errores
  - **NO usar browser** - solo backend/scripts
  - Usar `console.log` con emojis para claridad (✅ ❌ 📋)

### 4. 🧪 Execution \& Verification Phase
- [ ] Ejecutar el script de verificación: `npx -y tsx src/scripts/verify-[feature].ts`
- [ ] Revisar la salida del script
- [ ] Si hay errores:
  - Analizar la causa
  - Corregir el código
  - Volver a ejecutar el script
  - Repetir hasta que pase todas las verificaciones

### 5. ✅ Completion Phase
- [ ] Solo después de que el script de verificación pase sin errores
- [ ] Actualizar `task.md` marcando tareas como completadas
- [ ] Reportar al usuario con resumen de implementación exitosa

## Example Verification Script Template

```typescript
#!/usr/bin/env tsx
import dotenv from 'dotenv';
dotenv.config();

async function verifyFeature() {
  console.log('🔍 Starting verification of [Feature Name]\\n');
  
  try {
    // Test 1: Check configuration
    console.log('📋 Test 1: Checking configuration...');
    // verification logic
    console.log('✅ Configuration verified\\n');
    
    // Test 2: Check functionality
    console.log('📋 Test 2: Testing functionality...');
    // verification logic
    console.log('✅ Functionality working\\n');
    
    // Test 3: Edge cases
    console.log('📋 Test 3: Testing edge cases...');
    // verification logic
    console.log('✅ Edge cases handled\\n');
    
    console.log('🎉 All verifications passed!');
    process.exit(0);
    
  } catch (error) {
    console.error('❌ Verification failed:', error);
    process.exit(1);
  }
}

verifyFeature();
```

## Anti-Patterns to Avoid

❌ **NO hacer**:
- Reportar "todo listo" sin ejecutar verificaciones
- Usar browser para verificar funcionalidad backend
- Asumir que el código funciona sin probarlo
- Verificaciones manuales que no se pueden repetir

✅ **SÍ hacer**:
- Scripts automatizados y repetibles
- Verificaciones en backend con TypeScript
- Probar casos reales con datos reales
- Reportar solo después de verificación exitosa

## Documento aplicable en

Este workflow aplica a:
- Nuevas features
- Refactorizaciones
- Correcciones de bugs
- Cambios en configuración
- Migraciones de datos

**Última actualización**: 2026-02-05
