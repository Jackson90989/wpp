# Imagem Node.js Alpine
FROM node:18-alpine

# Instalar dependências do sistema
RUN apk add --no-cache \
    chromium \
    nss \
    freetype \
    harfbuzz \
    ca-certificates \
    && rm -rf /var/cache/apk/*

WORKDIR /app

# Copiar package.json
COPY package.json package-lock.json* ./

# Instalar dependências
RUN npm install --production --no-audit --no-fund

# Copiar código fonte (USAR CAMINHO RELATIVO)
COPY whatsapp-api.js .
COPY start.sh .

# Criar diretórios
RUN mkdir -p /app/sessions /app/logs

# CONFIGURAÇÃO IMPORTANTE: Garantir que start.sh tem permissão de execução
RUN chmod +x /app/start.sh

# Configurar variáveis
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium-browser
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
ENV NODE_OPTIONS="--max-old-space-size=256"

EXPOSE 3000

# Usar exec form para melhor logging
CMD ["/bin/sh", "/app/start.sh"]