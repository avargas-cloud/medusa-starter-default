#!/bin/bash
# Script para probar eventos localmente

echo "🧪 Probando Event Emission Local"
echo "=================================="
echo ""

# 1. Limpiar build corrupto
echo "📦 Limpiando build..."
rm -rf .medusa/server node_modules/.cache

# 2. Verificar subscribers
echo ""
echo "📋 Subscribers encontrados:"
ls -1 src/subscribers/*.ts

# 3. Iniciar Medusa en modo shared (server + worker juntos)
echo ""
echo "🚀 Iniciando Medusa (modo shared = server + worker)..."
echo "   Presiona Ctrl+C para detener"
echo ""

export MEDUSA_WORKER_MODE=shared
yarn dev
