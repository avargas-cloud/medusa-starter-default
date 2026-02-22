# 🛡️ Guía de Linting y Calidad de Código


## 📋 Descripción del Documento

| Campo | Detalle |
|-------|---------|
| **Propósito** | ESLint and TypeScript linting setup guide for the EcoPowerTech backend — configured tools, `.eslintrc` rules, and how to run lint checks before committing. |
| **Problemas que resuelve** | Inconsistent code style and undetected type errors across the backend codebase. Provides a shared linting baseline that catches common issues (unused variables, implicit `any`, missing return types) before they reach production. |
| **Resultado esperado** | Running `yarn lint` catches type errors and style violations across all TypeScript files. CI rejects commits that fail lint. All developers follow the same code quality standards. |
| **Scripts Creados** | — |

## Herramientas Instaladas

- **ESLint**: Análisis estático de código TypeScript
- **Prettier**: Formateo automático de código
- **TypeScript Strict Mode**: Verificación de tipos estricta

## Comandos Disponibles

### Verificación Completa
```bash
yarn code-quality
```
Ejecuta todas las verificaciones: tipos, linting y formateo.

### Linting
```bash
# Verificar errores
yarn lint

# Corregir automáticamente
yarn lint:fix
```

### Formateo
```bash
# Formatear todo el código
yarn format

# Solo verificar (no modifica archivos)
yarn format:check
```

### Type Checking
```bash
yarn type-check
```

## Reglas Principales

### ❌ Prohibido: `any` type
```typescript
// ❌ MAL
const data: any = fetchData();

// ✅ BIEN
const data: UserData = fetchData();
```

### ✅ Requerido: Tipado explícito en funciones
```typescript
// ❌ MAL
function processUser(user) {
  return user.name;
}

// ✅ BIEN
function processUser(user: User): string {
  return user.name;
}
```

### ✅ Imports organizados
```typescript
// Los imports se organizan automáticamente:
// 1. Node built-ins
// 2. External packages
// 3. Internal modules
// 4. Relative imports
```

## Ignorar Reglas (Solo Casos Excepcionales)

```typescript
// Ignorar línea específica
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const legacy: any = oldCode();

// Ignorar archivo completo (añadir al inicio)
/* eslint-disable @typescript-eslint/no-explicit-any */
```

## Integración con Editor

### VSCode
Instalar extensiones:
- ESLint (dbaeumer.vscode-eslint)
- Prettier (esbenp.prettier-vscode)

Settings.json:
```json
{
  "editor.formatOnSave": true,
  "editor.defaultFormatter": "esbenp.prettier-vscode",
  "editor.codeActionsOnSave": {
    "source.fixAll.eslint": true
  }
}
```

## Workflow Recomendado

### Antes de Commit
```bash
yarn code-quality
```

### Durante Desarrollo
```bash
# Auto-fix mientras desarrollas
yarn lint:fix
yarn format
```

### CI/CD (Futuro)
Agregar a GitHub Actions:
```yaml
- run: yarn code-quality
```
