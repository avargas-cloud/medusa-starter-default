# 🚀 Quick Start Guide

## Primera Vez en una Máquina Nueva

```bash
git clone https://github.com/avargas-cloud/medusa-starter-default.git
cd medusa-starter-default
./setup.sh
./dev.sh
```

**Tiempo esperado:** 3-5 minutos (primera vez con instalación de node_modules)

---

## Cada Vez que Vuelvas a Trabajar

```bash
git pull origin master
./dev.sh
```

**Tiempo esperado:** 10-30 segundos

---

## Si Algo Falla

### Problema: "Port 9000 already in use"
```bash
pkill -9 -f "node.*medusa"
./dev.sh
```

### Problema: "yarn.lock out of sync"
```bash
yarn install
./dev.sh
```

### Problema: MeiliSearch no arranca
```bash
rm -rf data.ms
./dev.sh
```

### Problema: Cambios en `package.json` o `medusa-config.ts`
```bash
yarn install
pkill -9 -f "node.*medusa"
./dev.sh
```

---

## Lo Que Hace `dev.sh` Automáticamente

1. ✅ Arranca MeiliSearch local (si existe `bin/meilisearch`)
2. ✅ Arranca Medusa Server
3. ✅ Recarga automáticamente si editas archivos
4. ✅ Limpia procesos cuando haces Ctrl+C

---

## URLs Importantes

- **Admin:** http://localhost:9000/app
- **API:** http://localhost:9000
- **MeiliSearch:** http://localhost:7700

---

## Credenciales de Desarrollo

Las credenciales están en tu `.env` file (NO committed to git).

Si no tienes `.env`, copia `.env.template`:
```bash
cp .env.template .env
```

---

## Troubleshooting Rápido

| Síntoma | Solución Rápida |
|---------|-----------------|
| "Cannot find module" | `yarn install` |
| "Port in use" | `pkill -9 -f "node.*medusa"` |
| MeiliSearch error | `rm -rf data.ms && ./dev.sh` |
| Config cambió | `yarn install && pkill -9 -f medusa && ./dev.sh` |
| Nada funciona | `./setup.sh` (reinstala todo) |

---

## Arquitectura Local vs Railway

### Local (Tu PC)
- Postgres: Railway (nube)
- Redis: Railway (nube)  
- MeiliSearch: Local (`bin/meilisearch`)
- Medusa: Local (puerto 9000)

### Railway (Producción)
- Postgres: Railway service
- Redis: Railway service
- MeiliSearch: Railway service
- Medusa: Railway service
