#!/bin/bash
# Carga NVM si existe
export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh"

# Inicia el servidor
echo "🚀 Iniciando servidor con Yarn..."
yarn dev
