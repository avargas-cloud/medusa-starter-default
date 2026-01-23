# 🚀 Setup Rápido - PC de Casa

## Pre-requisitos

1. **WSL/Ubuntu** instalado
2. **Git** configurado

## Pasos de Instalación

### 1. Clonar o Actualizar el Repositorio

```bash
cd ~/projects  # O tu carpeta de proyectos
git pull       # Si ya tienes el repo
# o
git clone <repo-url> medusa-starter-default
cd medusa-starter-default
```

### 2. Instalar NVM (Node Version Manager)

```bash
# Instalar NVM
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.7/install.sh | bash

# Activar NVM
export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh"

# Agregar a ~/.bashrc para persistencia
echo 'export NVM_DIR="$HOME/.nvm"' >> ~/.bashrc
echo '[ -s "$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh"' >> ~/.bashrc
```

### 3. Instalar Node 20 y Yarn

```bash
# Instalar Node 20
nvm install 20
nvm alias default 20

# Verificar instalación
node --version   # Debe mostrar v20.x.x
which node       # Debe mostrar /home/username/.nvm/...

# Instalar Yarn globalmente
npm install -g yarn

# Verificar Yarn
yarn --version   # Debe mostrar 1.22.x
```

### 4. Instalar Dependencias del Sistema

```bash
sudo apt update
sudo apt install -y git python3 make g++ build-essential curl
```

### 5. Configurar Variables de Entorno

```bash
# Copiar el archivo de ejemplo
cp .env.template .env

# Editar .env con tus credenciales
nano .env
```

**Variables críticas a configurar:**
- `DATABASE_URL` - PostgreSQL en Railway
- `REDIS_URL` - Redis en Railway  
- `MINIO_ENDPOINT` - MinIO endpoint
- `MINIO_ACCESS_KEY_ID` - MinIO access key
- `MINIO_SECRET_ACCESS_KEY` - MinIO secret key

### 6. Instalar Dependencias del Proyecto

```bash
# Instalar con Yarn (NO usar npm)
yarn install --frozen-lockfile
```

### 7. Build del Proyecto

```bash
yarn build
```

### 8. Ejecutar Migraciones (Solo primera vez)

```bash
yarn predeploy
```

### 9. Iniciar el Servidor de Desarrollo

```bash
# Opción 1: Script recomendado (ignora cambios en .md)
./dev.sh

# Opción 2: Script estándar
yarn dev
```

## ✅ Verificación

El servidor debe estar corriendo en:
- **Backend API:** http://localhost:9000
- **Admin Dashboard:** http://localhost:9000/app

## ⚠️ Reglas Importantes

### SIEMPRE usar Yarn, NUNCA npm:

```bash
# ❌ INCORRECTO
npm install
npm install some-package

# ✅ CORRECTO
yarn install
yarn add some-package
```

### Ubicación del proyecto

```bash
# ✅ CORRECTO - Filesystem de Linux
/home/username/projects/medusa-starter-default

# ❌ INCORRECTO - Filesystem de Windows (muy lento)
/mnt/c/Users/username/projects/medusa-starter-default
```

## 🔧 Troubleshooting

### "command not found: node"

```bash
# Activar NVM
export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh"
nvm use 20
```

### "command not found: yarn"

```bash
npm install -g yarn
```

### Build falla con errores de TypeScript

```bash
# Limpiar y reinstalar
rm -rf node_modules .medusa
yarn install
yarn build
```

### Server no inicia

```bash
# Verificar que las variables de entorno estén configuradas
cat .env | grep -E "(DATABASE_URL|REDIS_URL|MINIO)"

# Verificar conexión a base de datos
yarn predeploy
```

## 📚 Referencias

- [Guía completa de migración NPM a Yarn](file:///home/alejo/medusa-starter-default/docs/npm-to-yarn-migration.md)
- [Documentación de Medusa v2](https://docs.medusajs.com/)
