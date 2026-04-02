# Dev — Linting y Calidad de Codigo
> **Tipo**: Technical Reference
> **Repo**: backend
> **Ultima verificacion**: 2026-04-02
> **Estado**: Current

---

## Herramientas

| Herramienta | Version | Proposito |
|-------------|---------|-----------|
| ESLint | configurado en `.eslintrc` | Analisis estatico TypeScript |
| Prettier | configurado en `.prettierrc` | Formateo automatico |
| TypeScript | strict mode | Verificacion de tipos |

---

## Comandos

```bash
# Verificacion completa (type-check + lint + format:check)
yarn code-quality

# Solo linting
yarn lint
yarn lint:fix

# Solo formateo
yarn format        # modifica archivos
yarn format:check  # solo verifica (sin modificar)

# Solo tipos
yarn type-check    # tsc --noEmit
```

---

## Prettier Config (backend)

```json
{
  "printWidth": 80,
  "singleQuote": false,
  "semi": true,
  "tabWidth": 2,
  "trailingComma": "es5",
  "endOfLine": "lf"
}
```

---

## Reglas ESLint Principales

### Prohibido: `any` type

```typescript
// MAL
const data: any = fetchData()

// BIEN
const data: UserData = fetchData()
// o usar unknown con narrowing:
function getError(error: unknown): string {
  if (error instanceof Error) return error.message
  return "Unknown error"
}
```

### Requerido: Tipado explicito en funciones publicas

```typescript
// MAL
function processUser(user) {
  return user.name
}

// BIEN
function processUser(user: User): string {
  return user.name
}
```

### Imports organizados

El linter organiza imports automaticamente:
1. Node built-ins
2. External packages
3. Internal modules
4. Relative imports

---

## Ignorar Reglas (casos excepcionales)

```typescript
// Ignorar linea especifica
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const legacy: any = oldCode()

// Ignorar archivo completo (al inicio del archivo)
/* eslint-disable @typescript-eslint/no-explicit-any */
```

---

## Workflow Recomendado

```bash
# Durante desarrollo (auto-fix mientras editas)
yarn lint:fix && yarn format

# Antes de hacer commit
yarn code-quality

# Verificar que TypeScript no tiene errores
yarn type-check
```

---

## Editor (VSCode)

Instalar extensiones:
- `dbaeumer.vscode-eslint` — ESLint
- `esbenp.prettier-vscode` — Prettier

`settings.json`:
```json
{
  "editor.formatOnSave": true,
  "editor.defaultFormatter": "esbenp.prettier-vscode",
  "editor.codeActionsOnSave": {
    "source.fixAll.eslint": true
  }
}
```

---

## Archivos Clave

| Tipo | Ruta Completa | Proposito |
|------|---------------|-----------|
| Config | `/home/alejo/webapps/ecopowertech-workspace/backend/.eslintrc` | Reglas ESLint |
| Config | `/home/alejo/webapps/ecopowertech-workspace/backend/.prettierrc` | Config Prettier |
| Config | `/home/alejo/webapps/ecopowertech-workspace/backend/tsconfig.json` | TypeScript strict mode |
| Config | `/home/alejo/webapps/ecopowertech-workspace/backend/package.json` | Scripts lint/format/type-check |
