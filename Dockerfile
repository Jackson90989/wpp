# Imagem Node.js Alpine (mais leve)
FROM node:18-alpine

# Instalar dependências do sistema para o Puppeteer no Alpine
# NÃO precisa instalar glibc - Alpine já tem musl libc
RUN apk add --no-cache \
    chromium \
    nss \
    freetype \
    harfbuzz \
    ca-certificates \
    ttf-freefont \
    font-noto \
    font-noto-cjk \
    && rm -rf /var/cache/apk/*

# Definir diretório de trabalho
WORKDIR /app

# Copiar package.json primeiro (cache)
COPY package.json package-lock.json* ./

# Instalar dependências (apenas produção)
RUN npm install --production --no-audit --no-fund

# Copiar código fonte
COPY whatsapp-api.js .
COPY start.sh .

# Criar diretórios
RUN mkdir -p /app/sessions /app/logs

# Configurar variáveis para Alpine
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium-browser
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
ENV NODE_OPTIONS="--max-old-space-size=256"
ENV CHROME_PATH=/usr/bin/chromium-browser

# Tornar script executável
RUN chmod +x /app/start.sh

# Expor porta
EXPOSE 3000

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=40s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:3000/status || exit 1

# Comando de inicialização
CMD ["/app/start.sh"]