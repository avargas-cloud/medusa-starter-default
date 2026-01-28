# 🚨 Railway Deployment Failed - Troubleshooting

## Error Observado

```
FAILED - Deployment failed during build process
Build › Build Image (02:04)
Failed to build an image. Please check the build logs for more details.
```

El deployment se detuvo durante `yarn install --frozen-lockfile`.

---

## Posibles Causas

### 1️⃣ **Memoria Insuficiente Durante Instalación**

`medusa-plugin-auth` y sus dependencias (especialmente `passport`) pueden consumir mucha memoria durante la instalación.

**Solución:**
```bash
# En Railway, incrementar memoria del servicio
# Settings → Resources → Memory: 2GB o más
```

---

### 2️⃣ **Dependencias Peer Missing**

`medusa-plugin-auth` requiere `passport` como peer dependency.

**Verificar en package.json:**
```json
{
  "dependencies": {
    "medusa-plugin-auth": "^1.11.1"
    // Verificar si falta passport
  }
}
```

**Solución:**
```bash
# Local
yarn add passport @types/passport

# Commit y push
git add package.json yarn.lock
git commit -m "fix: Add passport as explicit dependency"
git push
```

---

### 3️⃣ **Build Timeout**

Railway tiene timeout de build (~10 minutos). Si `yarn install` tarda mucho, falla.

**Solución:**
- Usar cache de node_modules
- Railway debería cachear automáticamente

---

### 4️⃣ **Conflictos de Versiones**

Posible conflicto entre dependencias de Medusa v2 y `medusa-plugin-auth`.

**Verificar:**
```bash
# Local - revisar warnings
yarn install

# Buscar conflictos de peer dependencies
```

---

## 🔍 Pasos para Diagnosticar

### 1. Ver Logs Completos en Railway

1. Ve a Railway → Tu proyecto
2. Click en el deployment fallido
3. Click "View Logs"
4. **Scroll hasta el FINAL** (donde está el error real)
5. Buscar:
   - `error`
   - `ELIFECYCLE`
   - `out of memory`
   - `peer dep missing`

### 2. Copiar Error Exacto

El error específico estará cerca del final de los logs. Algo como:

```bash
error An unexpected error occurred: "ELIFECYCLE"
error Command failed with exit code 1.
```

O:

```bash
FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory
```

---

## 🛠️ Soluciones Rápidas

### Opción A: Agregar Passport Explícitamente

Es probable que `medusa-plugin-auth` necesite `passport` como dependencia explícita:

```bash
yarn add passport @types/passport passport-google-oauth20
```

### Opción B: Incrementar Memoria en Railway

Si el error es de memoria:

1. Railway Dashboard → Settings → Resources
2. Memory: 2048 MB (o más)
3. Re-deploy

### Opción C: Remover Plugin Temporalmente

Si necesitas que el deployment funcione YA:

```bash
# medusa-config.ts
// Comentar temporalmente el plugin
plugins: [
  // {
  //   resolve: "medusa-plugin-auth",
  //   ...
  // }
]

# package.json
// Remover medusa-plugin-auth de dependencies
```

---

## 📋 Siguiente Paso

**Por favor comparte los últimos ~50 líneas de los logs de Railway.**

En Railway:
1. Click "View Logs" en el deployment fallido
2. Scroll hasta el **FINAL**
3. Copia desde donde dice `error` hasta el final
4. Pégalo aquí

Con el error exacto puedo darte la solución precisa. 🔧
