#!/bin/bash

echo "=========================================="
echo "📱 WHATSAPP API SERVICE"
echo "=========================================="

# Criar diretórios
mkdir -p /app/sessions /app/logs

echo "📱 Starting WhatsApp API..."
echo "   Sessions: /app/sessions"
echo "   Port: 3000"

# Iniciar serviço
node whatsapp-api.js 2>&1 | tee /app/logs/whatsapp.log