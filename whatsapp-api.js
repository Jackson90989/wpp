const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const express = require('express');
const axios = require('axios');
const qrcode = require('qrcode-terminal');
const QRCode = require('qrcode');  // Adicionar esta dependência
const fs = require('fs');
const path = require('path');

const app = express();
app.use(express.json());

const API_KEY = process.env.WHATSAPP_API_KEY || '';
const FLASK_WEBHOOK_URL = process.env.FLASK_WEBHOOK_URL || 'http://localhost:5000/api/whatsapp-webhook';
const FLASK_TIMEOUT_MS = Number(process.env.FLASK_TIMEOUT_MS || 90000);
const SESSIONS_DIR = path.resolve(process.env.WHATSAPP_SESSIONS_DIR || './sessions');
const LOCK_FILE = path.join(SESSIONS_DIR, '.whatsapp-api.lock');

let lockFd = null;
let lastQRCode = null;  // Armazenar o último QR Code gerado
let clientReady = false;
let qrGenerated = false;

function processExists(pid) {
    if (!pid || Number.isNaN(Number(pid))) {
        return false;
    }

    try {
        process.kill(Number(pid), 0);
        return true;
    } catch {
        return false;
    }
}

function acquireSingleInstanceLock() {
    fs.mkdirSync(SESSIONS_DIR, { recursive: true });

    try {
        lockFd = fs.openSync(LOCK_FILE, 'wx');
        const lockPayload = {
            pid: process.pid,
            createdAt: new Date().toISOString(),
            cwd: process.cwd()
        };
        fs.writeFileSync(lockFd, JSON.stringify(lockPayload, null, 2));
        return;
    } catch (error) {
        if (error && error.code !== 'EEXIST') {
            throw error;
        }
    }

    let lockInfo = null;
    try {
        lockInfo = JSON.parse(fs.readFileSync(LOCK_FILE, 'utf8'));
    } catch {
        // lock corrompido ou ilegivel
    }

    const pidAtivo = lockInfo && processExists(lockInfo.pid);
    if (pidAtivo) {
        throw new Error(
            `Ja existe uma instancia do whatsapp-api em execucao (PID ${lockInfo.pid}). ` +
            'Encerre a instancia atual antes de iniciar outra.'
        );
    }

    try {
        fs.unlinkSync(LOCK_FILE);
    } catch {
        // ignora
    }

    lockFd = fs.openSync(LOCK_FILE, 'wx');
    const lockPayload = {
        pid: process.pid,
        createdAt: new Date().toISOString(),
        cwd: process.cwd(),
        recoveredStaleLock: true
    };
    fs.writeFileSync(lockFd, JSON.stringify(lockPayload, null, 2));
}

function releaseSingleInstanceLock() {
    try {
        if (lockFd !== null) {
            fs.closeSync(lockFd);
            lockFd = null;
        }
        if (fs.existsSync(LOCK_FILE)) {
            const lockInfo = JSON.parse(fs.readFileSync(LOCK_FILE, 'utf8'));
            if (Number(lockInfo.pid) === Number(process.pid)) {
                fs.unlinkSync(LOCK_FILE);
            }
        }
    } catch {
        // sem throw em encerramento
    }
}

try {
    acquireSingleInstanceLock();
} catch (error) {
    console.error(`Error: ${error.message}`);
    process.exit(1);
}

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetryableNetworkError(error) {
    const retryableCodes = new Set(['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EPIPE', 'ENOTFOUND']);
    return retryableCodes.has(error?.code);
}

async function enviarParaFlaskComRetry(payload, maxTentativas = 3) {
    let ultimaErro = null;

    for (let tentativa = 1; tentativa <= maxTentativas; tentativa += 1) {
        try {
            const response = await axios.post(FLASK_WEBHOOK_URL, payload, {
                timeout: FLASK_TIMEOUT_MS,
                headers: { 'Content-Type': 'application/json' }
            });
            return response;
        } catch (error) {
            ultimaErro = error;
            const retryavel = isRetryableNetworkError(error);
            const ultimaTentativa = tentativa === maxTentativas;

            console.error(`Failed to call Flask (attempt ${tentativa}/${maxTentativas})`, {
                code: error?.code || null,
                message: error?.message || 'unknown error'
            });

            if (!retryavel || ultimaTentativa) {
                throw error;
            }

            await sleep(300 * tentativa);
        }
    }

    throw ultimaErro;
}

function requireApiKey(req, res, next) {
    if (!API_KEY) {
        return next();
    }

    const receivedKey = req.headers['x-api-key'];
    if (receivedKey !== API_KEY) {
        return res.status(401).json({
            sucesso: false,
            erro: 'Nao autorizado'
        });
    }

    return next();
}

function safeMessagePreview(text, maxLen = 80) {
    if (!text) {
        return '';
    }
    const normalized = String(text).replace(/\s+/g, ' ').trim();
    return normalized.length > maxLen ? `${normalized.slice(0, maxLen)}...` : normalized;
}

function extrairCaminhoPdfDaResposta(texto) {
    if (!texto) {
        return null;
    }

    const normalizado = String(texto).replace(/`/g, '');
    const match = normalizado.match(/(documentos_gerados[\\/][^\s*]+)/i);
    return match ? match[1] : null;
}

function limparLinhaCaminhoPdf(texto) {
    if (!texto) {
        return '';
    }

    const textoNormalizado = String(texto).replace(/`/g, '');

    return textoNormalizado.replace(
        /^\s*📎\s*\*\*?PDF\s+gerado:\*\*?\s*documentos_gerados[\\/].*$/gim,
        '📎 **PDF enviado em anexo.** Se nao abrir, me avise que eu reenvio.'
    );
}

function isValidChatNumber(numero) {
    const digits = String(numero || '').replace(/\D/g, '');
    return digits.length >= 12 && digits.length <= 13;
}

function isIndividualMessage(message) {
    const isIndividual = message.from.includes('@c.us');
    const isGroup = message.from.includes('@g.us');
    const isBroadcast = message.from.includes('@broadcast');
    const isStatus = message.from === 'status@broadcast';
    
    console.log(`Debug - Message type:`);
    console.log(`   • From: ${message.from}`);
    console.log(`   • Individual (@c.us): ${isIndividual}`);
    console.log(`   • Group (@g.us): ${isGroup}`);
    console.log(`   • Broadcast: ${isBroadcast}`);
    console.log(`   • Status: ${isStatus}`);
    
    return isIndividual && !isGroup && !isBroadcast && !isStatus;
}

// ==================== CLIENTE WHATSAPP ====================
const client = new Client({
    authStrategy: new LocalAuth({ dataPath: SESSIONS_DIR }),
    puppeteer: { 
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
    }
});

// ==================== EVENTO QR CODE (SOLUÇÃO 3) ====================
client.on('qr', async (qr) => {
    qrGenerated = true;
    lastQRCode = qr;
    
    console.log('\n📱 QR Code gerado!');
    console.log('=========================================');
    console.log('Para escanear o QR Code:');
    console.log('1. Acesse: http://localhost:3000/qr-code (local)');
    console.log('   ou: https://seu-app.onrender.com/qr-code (Render)');
    console.log('2. Escaneie com WhatsApp > Menu > WhatsApp Web');
    console.log('=========================================\n');
    
    // Também mostrar no terminal como fallback
    qrcode.generate(qr, { small: true });
    
    // Salvar QR Code em arquivo (útil para debug)
    try {
        fs.writeFileSync(path.join(SESSIONS_DIR, 'last_qr.txt'), qr);
        console.log('✅ QR Code salvo em:', path.join(SESSIONS_DIR, 'last_qr.txt'));
    } catch (err) {
        console.error('Erro ao salvar QR:', err);
    }
});

client.on('ready', () => {
    clientReady = true;
    qrGenerated = false;
    lastQRCode = null;
    console.log('✅ WhatsApp client connected successfully!');
    console.log(`📱 Number: ${client.info?.wid?.user || 'Unknown'}`);
});

client.on('authenticated', () => {
    console.log('✅ Authenticated successfully!');
});

client.on('auth_failure', (msg) => {
    console.error('❌ Authentication failed:', msg);
    clientReady = false;
});

client.on('disconnected', (reason) => {
    console.log('⚠️ Client disconnected:', reason);
    clientReady = false;
});

// ==================== ENDPOINT QR CODE (SOLUÇÃO 3) ====================
app.get('/qr-code', async (req, res) => {
    if (!lastQRCode) {
        return res.json({
            status: clientReady ? 'connected' : 'waiting',
            message: clientReady ? 'WhatsApp já está conectado!' : 'Aguardando QR Code ser gerado...',
            qr_generated: qrGenerated,
            client_ready: clientReady
        });
    }
    
    try {
        // Gerar QR Code como imagem Base64
        const qrImage = await QRCode.toDataURL(lastQRCode);
        
        // Retornar HTML com QR Code
        res.send(`
            <!DOCTYPE html>
            <html>
            <head>
                <title>WhatsApp QR Code - UNIN</title>
                <meta charset="UTF-8">
                <meta name="viewport" content="width=device-width, initial-scale=1.0">
                <style>
                    * { margin: 0; padding: 0; box-sizing: border-box; }
                    body {
                        font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
                        background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
                        min-height: 100vh;
                        display: flex;
                        align-items: center;
                        justify-content: center;
                        padding: 20px;
                    }
                    .container {
                        background: white;
                        border-radius: 20px;
                        padding: 40px;
                        max-width: 500px;
                        width: 100%;
                        text-align: center;
                        box-shadow: 0 20px 60px rgba(0,0,0,0.3);
                        animation: fadeIn 0.5s ease;
                    }
                    @keyframes fadeIn {
                        from { opacity: 0; transform: translateY(-20px); }
                        to { opacity: 1; transform: translateY(0); }
                    }
                    h1 {
                        color: #333;
                        margin-bottom: 10px;
                        font-size: 1.8em;
                    }
                    .status {
                        padding: 10px;
                        border-radius: 10px;
                        margin: 20px 0;
                        font-weight: bold;
                    }
                    .status.connected {
                        background: #d4edda;
                        color: #155724;
                        border: 1px solid #c3e6cb;
                    }
                    .status.waiting {
                        background: #fff3cd;
                        color: #856404;
                        border: 1px solid #ffeeba;
                    }
                    .qr-container {
                        background: white;
                        padding: 20px;
                        border-radius: 10px;
                        margin: 20px 0;
                        border: 2px solid #e0e0e0;
                    }
                    img {
                        max-width: 100%;
                        height: auto;
                    }
                    .instructions {
                        background: #f8f9fa;
                        padding: 15px;
                        border-radius: 10px;
                        margin: 20px 0;
                        text-align: left;
                    }
                    .instructions ol {
                        margin-left: 20px;
                        color: #666;
                    }
                    .instructions li {
                        margin: 10px 0;
                    }
                    button {
                        background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
                        color: white;
                        border: none;
                        padding: 12px 24px;
                        border-radius: 25px;
                        font-size: 1em;
                        cursor: pointer;
                        margin-top: 20px;
                        transition: transform 0.2s;
                    }
                    button:hover {
                        transform: scale(1.05);
                    }
                    .footer {
                        margin-top: 20px;
                        font-size: 0.8em;
                        color: #999;
                    }
                    .refresh-info {
                        font-size: 0.8em;
                        color: #666;
                        margin-top: 10px;
                    }
                </style>
            </head>
            <body>
                <div class="container">
                    <h1>📱 WhatsApp Web</h1>
                    <p>Escaneie o QR Code para conectar</p>
                    
                    <div class="status ${clientReady ? 'connected' : 'waiting'}">
                        ${clientReady ? '✅ CONECTADO! WhatsApp está online' : '⏳ AGUARDANDO ESCANEAMENTO'}
                    </div>
                    
                    ${!clientReady ? `
                        <div class="qr-container">
                            <img src="${qrImage}" alt="QR Code" />
                        </div>
                        
                        <div class="instructions">
                            <strong>📌 Como escanear:</strong>
                            <ol>
                                <li>Abra o WhatsApp no seu celular</li>
                                <li>Toque em <strong>Menu</strong> (⋮) ou <strong>Configurações</strong></li>
                                <li>Selecione <strong>WhatsApp Web</strong></li>
                                <li>Escaneie o QR Code acima</li>
                            </ol>
                        </div>
                        
                        <button onclick="location.reload()">🔄 Atualizar</button>
                        <div class="refresh-info">
                            O QR Code atualiza automaticamente a cada 60 segundos<br>
                            Se expirar, atualize a página
                        </div>
                    ` : `
                        <div class="instructions">
                            <strong>✅ WhatsApp já está conectado!</strong>
                            <p style="margin-top: 10px;">Número: ${client.info?.wid?.user || 'Desconhecido'}</p>
                            <p>Seu sistema está pronto para receber mensagens.</p>
                        </div>
                        <button onclick="window.location.href='/status'">📊 Ver Status</button>
                    `}
                    
                    <div class="footer">
                        <p>UNIN Academic System | WhatsApp Integration</p>
                    </div>
                </div>
                
                <script>
                    // Auto-refresh a cada 30 segundos se não estiver conectado
                    ${!clientReady ? `
                        setTimeout(() => {
                            location.reload();
                        }, 30000);
                    ` : ''}
                </script>
            </body>
            </html>
        `);
    } catch (error) {
        console.error('Erro ao gerar QR Code:', error);
        res.status(500).send(`
            <html>
            <body>
                <h1>Erro ao gerar QR Code</h1>
                <p>${error.message}</p>
                <button onclick="location.reload()">Tentar novamente</button>
            </body>
            </html>
        `);
    }
});

// ==================== ENDPOINT PARA OBTER QR COMO JSON ====================
app.get('/qr-code/json', async (req, res) => {
    if (!lastQRCode) {
        return res.json({
            success: false,
            status: clientReady ? 'connected' : 'waiting',
            message: clientReady ? 'WhatsApp já está conectado!' : 'Aguardando QR Code...'
        });
    }
    
    try {
        const qrImage = await QRCode.toDataURL(lastQRCode);
        res.json({
            success: true,
            status: 'waiting',
            qr_text: lastQRCode,
            qr_base64: qrImage,
            client_ready: clientReady
        });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// ==================== EVENTO DE MENSAGENS ====================
client.on('message', async (message) => {
    console.log(`\nMessage received from ${message.from}: ${safeMessagePreview(message.body)}`);

    if (!message.body || !String(message.body).trim()) {
        console.log('Skipping empty message');
        return;
    }
    
    if (!isIndividualMessage(message)) {
        console.log(`Skipping message (not individual): ${message.from}`);
        return;
    }
    
    if (message.fromMe) {
        console.log(`Skipping bot's own message`);
        return;
    }
    
    console.log(`Processing individual message from: ${message.from}`);
    
    try {
        const response = await enviarParaFlaskComRetry({
            numero: message.from,
            mensagem: message.body,
            tipo: 'recebida',
            pipeline: 'aluno_avancado',
            message_id: message.id._serialized,
            timestamp: new Date().toISOString()
        });
        
        if (response.data && response.data.resposta) {
            const respostaOriginal = String(response.data.resposta);
            const caminhoRelativoPdf = extrairCaminhoPdfDaResposta(respostaOriginal);
            const respostaTexto = caminhoRelativoPdf
                ? limparLinhaCaminhoPdf(respostaOriginal)
                : respostaOriginal;

            await message.reply(respostaTexto);
            console.log('Reply sent successfully');

            if (caminhoRelativoPdf) {
                try {
                    const caminhoAbsolutoPdf = path.resolve(caminhoRelativoPdf);
                    if (fs.existsSync(caminhoAbsolutoPdf)) {
                        const media = MessageMedia.fromFilePath(caminhoAbsolutoPdf);
                        await message.reply(media, undefined, {
                            sendMediaAsDocument: true,
                            caption: 'Segue o PDF em anexo. Se nao abrir, me avise que eu reenvio.'
                        });
                        console.log(`Attached PDF sent in chat: ${caminhoAbsolutoPdf}`);
                    } else {
                        console.warn(`PDF referenced in reply not found: ${caminhoAbsolutoPdf}`);
                    }
                } catch (pdfError) {
                    console.error('Failed to send attached PDF in chat:', pdfError?.message || pdfError);
                }
            }
        }
    } catch (error) {
        console.error('Error communicating with Flask:', {
            code: error?.code || null,
            message: error?.message || 'unknown error'
        });
        
        try {
            await message.reply('Sorry, I am having trouble processing your message. Please try again in a moment.');
        } catch (replyError) {
            console.error('Error sending fallback message:', replyError.message);
        }
    }
});

// ==================== ENDPOINTS DA API ====================
app.post('/enviar', requireApiKey, async (req, res) => {
    const { numero, mensagem } = req.body;
    
    if (!numero || !mensagem) {
        return res.status(400).json({ 
            sucesso: false, 
            erro: 'Número e mensagem são obrigatórios' 
        });
    }
    
    if (!clientReady) {
        return res.status(503).json({ 
            sucesso: false, 
            erro: 'Cliente WhatsApp não está pronto' 
        });
    }

    if (!isValidChatNumber(numero)) {
        return res.status(400).json({
            sucesso: false,
            erro: 'Numero invalido. Use formato com codigo do pais e DDD (ex: 5511999999999)'
        });
    }
    
    try {
        const numeroLimpo = numero.replace(/\D/g, '');
        const chatId = `${numeroLimpo}@c.us`;
        
        const response = await client.sendMessage(chatId, mensagem);
        console.log(`Message sent to ${numero}`);
        
        res.json({ 
            sucesso: true, 
            id: response.id._serialized,
            timestamp: new Date().toISOString()
        });
    } catch (error) {
        console.error('Error sending message:', error.message);
        res.status(500).json({ 
            sucesso: false, 
            erro: error.message 
        });
    }
});

app.post('/enviar-arquivo', requireApiKey, async (req, res) => {
    const { numero, arquivo, legenda } = req.body;

    if (!numero || !arquivo) {
        return res.status(400).json({
            sucesso: false,
            erro: 'Numero e arquivo sao obrigatorios'
        });
    }

    if (!clientReady) {
        return res.status(503).json({
            sucesso: false,
            erro: 'Cliente WhatsApp nao esta pronto'
        });
    }

    if (!isValidChatNumber(numero)) {
        return res.status(400).json({
            sucesso: false,
            erro: 'Numero invalido. Use formato com codigo do pais e DDD (ex: 5511999999999)'
        });
    }

    try {
        const numeroLimpo = String(numero).replace(/\D/g, '');
        const numeroId = await client.getNumberId(numeroLimpo);
        const chatId = numeroId?._serialized || `${numeroLimpo}@c.us`;
        const arquivoAbsoluto = path.resolve(String(arquivo));

        if (!fs.existsSync(arquivoAbsoluto)) {
            return res.status(404).json({
                sucesso: false,
                erro: `Arquivo nao encontrado: ${arquivoAbsoluto}`
            });
        }

        const media = MessageMedia.fromFilePath(arquivoAbsoluto);
        const response = await client.sendMessage(chatId, media, {
            caption: legenda || '',
            sendMediaAsDocument: true
        });

        console.log(`File sent to ${numeroLimpo}: ${arquivoAbsoluto}`);
        return res.json({
            sucesso: true,
            id: response.id._serialized,
            timestamp: new Date().toISOString()
        });
    } catch (error) {
        console.error('Error sending file:', error.message);
        return res.status(500).json({
            sucesso: false,
            erro: error.message
        });
    }
});

app.get('/status', (req, res) => {
    res.json({
        status: clientReady ? 'online' : 'offline',
        qr_generated: qrGenerated,
        qr_available: !!lastQRCode,
        info: client.info ? {
            number: client.info.wid.user,
            pushname: client.info.pushname,
            platform: client.info.platform
        } : null
    });
});

app.post('/restart', requireApiKey, async (req, res) => {
    try {
        clientReady = false;
        qrGenerated = false;
        lastQRCode = null;
        await client.destroy();
        client.initialize();
        res.json({ sucesso: true, mensagem: 'Cliente reiniciado' });
    } catch (error) {
        res.status(500).json({ sucesso: false, erro: error.message });
    }
});

// ==================== INICIALIZAÇÃO ====================
client.initialize();

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
    console.log(`\n🚀 WhatsApp API running on port ${PORT}`);
    console.log(`========================================`);
    console.log(`📱 Para conectar o WhatsApp:`);
    console.log(`   Local: http://localhost:${PORT}/qr-code`);
    console.log(`   Render: https://seu-app.onrender.com/qr-code`);
    console.log(`========================================`);
    console.log(`📡 Flask webhook: ${FLASK_WEBHOOK_URL}`);
    console.log(`🔐 API key: ${API_KEY ? 'ENABLED' : 'DISABLED'}`);
    console.log(`📁 Sessions: ${SESSIONS_DIR}`);
    console.log(`========================================\n`);
});

// Tratamento de encerramento
process.on('SIGINT', async () => {
    console.log('\n🛑 Shutting down WhatsApp client...');
    await client.destroy();
    releaseSingleInstanceLock();
    process.exit(0);
});

process.on('SIGTERM', async () => {
    console.log('\n🛑 Shutting down WhatsApp client (SIGTERM)...');
    try {
        await client.destroy();
    } catch {
        // ignorar
    }
    releaseSingleInstanceLock();
    process.exit(0);
});

process.on('uncaughtException', (error) => {
    console.error('Fatal error:', error?.message || error);
    releaseSingleInstanceLock();
    process.exit(1);
});