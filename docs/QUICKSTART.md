# 🚀 Quick Start Guide

## Primera Vez en una Máquina Nueva

```bash
git clone https://github.com/avargas-cloud/medusa-starter-default.git
cd medusa-starter-default
./setup.sh
./dev.sh
```

**Tiempo esperado:** 2-3 minutos (primera vez con instalación de node_modules)

---

## Cada Vez que Vuelvas a Trabajar

```bash
git pull origin master
./dev.sh
```

**Tiempo esperado:** 10-30 segundos

---

## Arquitectura Simplificada

**TODO corre en Railway (nube):**
- ✅ PostgreSQL (base de datos)
- ✅ Redis (cache/eventos)  
- ✅ MeiliSearch (búsqueda avanzada)

**Solo local:**
- 💻 Medusa Server (puerto 9000)

**Ventajas:**
- Sin setup complicado de servicios locales
- Mismos datos en casa/trabajo/laptop
- Un solo comando: `./dev.sh`

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

### Problema: Cambios en `package.json` o `medusa-config.ts`
```bash
yarn install
pkill -9 -f "node.*medusa"
./dev.sh
```

---

## Lo Que Hace `dev.sh` Automáticamente

1. ✅ Arranca Medusa Server
2. ✅ Se conecta a Railway (Postgres, Redis, MeiliSearch)
3. ✅ Recarga automáticamente si editas archivos
4. ✅ Limpia procesos cuando haces Ctrl+C

---

## URLs Importantes

- **Admin:** http://localhost:9000/app
- **API:** http://localhost:9000
- **Railway Dashboard:** https://railway.app/project/[tu-proyecto]

---

## Troubleshooting Rápido

| Síntoma | Solución Rápida |
|---------|-----------------|
| "Cannot find module" | `yarn install` |
| "Port in use" | `pkill -9 -f "node.*medusa"` |
| Config cambió | `yarn install && pkill -9 -f medusa && ./dev.sh` |
| Nada funciona | `./setup.sh` (reinstala todo) |
| MeiliSearch error | Verifica Railway dashboard - servicio corriendo? |

---

## ¿Por Qué Todo en Railway?

✅ **Simple:** Un solo comando `./dev.sh`  
✅ **Consistente:** Mismos datos en todas las máquinas  
✅ **Sin setup:** No necesitas instalar Postgres/Redis/MeiliSearch local  
✅ **Portátil:** Cambias de PC y funciona igual  

La única "desventaja" es que necesitas internet, pero si necesitas la DB de Railway de todas formas, no importa.
