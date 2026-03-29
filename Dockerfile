# Imagem Node.js Alpine (muito mais leve)
FROM node:18-alpine

# Instalar dependências do sistema para o Puppeteer no Alpine
RUN apk add --no-cache \
    chromium \
    nss \
    freetype \
    freetype-dev \
    harfbuzz \
    ca-certificates \
    ttf-freefont \
    fontconfig \
    && apk add --no-cache --virtual .build-deps \
    wget \
    && wget -q -O /etc/apk/keys/sgerrand.rsa.pub https://alpine-pkgs.sgerrand.com/sgerrand.rsa.pub \
    && wget https://github.com/sgerrand/alpine-pkg-glibc/releases/download/2.34-r0/glibc-2.34-r0.apk \
    && apk add --no-cache glibc-2.34-r0.apk \
    && rm glibc-2.34-r0.apk \
    && apk del .build-deps

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

# Health check simplificado para Alpine
HEALTHCHECK --interval=30s --timeout=10s --start-period=40s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:3000/status || exit 1

# Comando de inicialização
CMD ["/app/start.sh"]