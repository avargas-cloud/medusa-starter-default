#!/bin/bash
# Script to create admin user in production Railway database

# Set environment to production to use Railway DATABASE_URL
export NODE_ENV=production

echo "🔐 Creating admin user for Medusa dashboard..."
echo ""
echo "📧 Email: test@ecopowertech.com"
echo "🔑 Password: TestAdmin2026!"
echo ""

# Use Medusa CLI to create admin user
npx medusa user -e test@ecopowertech.com -p TestAdmin2026!

echo ""
echo "✅ Admin user created!"
echo ""
echo "🌐 Login at: https://medusa-starter-default-production-b69e.up.railway.app/app/login"
