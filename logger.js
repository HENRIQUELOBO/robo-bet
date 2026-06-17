// logger.js
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const http = require('http');
const config = require('./config');

const CAMINHO_LOG_CSV = path.join(__dirname, 'historico_gatilhos.csv');

let clientesSSE = [];
let dadosUltimosJogos = [];
let _callbackAdicionarJogo = null;
// Mapa de screenshots momentum: { [jogoId]: base64String }
const _screenshotsMomentum = new Map();

function registrarCallbackAdicionarJogo(fn) {
    _callbackAdicionarJogo = fn;
}

const server = http.createServer((req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') { res.writeHead(200); res.end(); return; }

    if (req.url === '/events' && req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' });
        clientesSSE.push(res);
        res.write(`data: ${JSON.stringify(dadosUltimosJogos)}\n\n`);
        req.on('close', () => { clientesSSE = clientesSSE.filter(client => client !== res); });

    } else if (req.url.startsWith('/screenshot/') && req.method === 'GET') {
        // Serve a imagem do gráfico momentum como JPEG binário
        const jogoId = req.url.split('/screenshot/')[1]?.split('?')[0];
        const imgBase64 = jogoId ? _screenshotsMomentum.get(jogoId) : null;
        if (imgBase64) {
            const buffer = Buffer.from(imgBase64.replace('data:image/jpeg;base64,', ''), 'base64');
            res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Cache-Control': 'no-store' });
            res.end(buffer);
        } else {
            res.writeHead(204); res.end(); // No Content — ainda sem screenshot
        }

    } else if (req.url === '/add-game' && req.method === 'POST') {
        let body = '';
        req.on('data', chunk => { body += chunk; });
        req.on('end', async () => {
            try {
                const { url } = JSON.parse(body);
                if (!url || !url.startsWith('http')) {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ ok: false, erro: 'URL inválida' }));
                    return;
                }
                if (_callbackAdicionarJogo) {
                    await _callbackAdicionarJogo(url);
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ ok: true }));
                } else {
                    res.writeHead(503, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ ok: false, erro: 'Engine ainda não pronta' }));
                }
            } catch (e) {
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ ok: false, erro: e.message }));
            }
        });

    } else {
        res.writeHead(404); res.end();
    }
});

server.listen(3000, '0.0.0.0', () => {});

function _formatarDataHora() {
    const d = new Date();
    const dd  = String(d.getDate()).padStart(2, '0');
    const mm  = String(d.getMonth() + 1).padStart(2, '0');
    const yyyy = d.getFullYear();
    const hh  = String(d.getHours()).padStart(2, '0');
    const mi  = String(d.getMinutes()).padStart(2, '0');
    const ss  = String(d.getSeconds()).padStart(2, '0');
    return {
        data: `${dd}-${mm}-${yyyy}`,
        hora: `${hh}:${mi}:${ss}`
    };
}

function _sanitizarNomeJogo(nome) {
    // Normaliza acentos (Ö→O, ö→o, é→e, etc.) antes de remover caracteres especiais
    return nome
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/\s+/g, '_')
        .replace(/[^a-zA-Z0-9_]/g, '')
        || 'jogo_sem_nome';
}

function registrarTelemetriaContinua(jogo) {
    if (!jogo) return;
    // Usa o nome real do jogo ou, como fallback seguro, o ID da URL (nunca bloqueia o log)
    const nomeEfetivo = (jogo.nomePartida && !jogo.nomePartida.includes('Carregando'))
        ? jogo.nomePartida
        : (jogo.id ? `jogo_${jogo.id}` : null);
    if (!nomeEfetivo) return;
    try {
        const { data: dataFormatada, hora: horaMinutoSegundo } = _formatarDataHora();
        const nomeJogoSanitizado = _sanitizarNomeJogo(nomeEfetivo);
        const pastaTelemetria = path.join(__dirname, 'log', 'telemetria');
        if (!fs.existsSync(pastaTelemetria)) fs.mkdirSync(pastaTelemetria, { recursive: true });

        const caminhoTxt = path.join(pastaTelemetria, `telemetria_${nomeJogoSanitizado}_${dataFormatada}.txt`);
        const linhaLog = `[${horaMinutoSegundo}] | Min: ${jogo.tempo}' | Placar: ${jogo.placar} | APM Max: ${jogo.pressao.toFixed(2)} | xG C: ${jogo.xgCasa.toFixed(2)} - xG F: ${jogo.xgFora.toFixed(2)} | APM10m C/F: ${jogo.momentum.ataquesCasa}/${jogo.momentum.ataquesFora}\n`;
        fs.appendFileSync(caminhoTxt, linhaLog, 'utf8');
    } catch (err) {
        // Log de erro no stderr para diagnóstico sem quebrar o fluxo principal
        process.stderr.write(`[LOGGER ERROR] registrarTelemetriaContinua: ${err.message}\n`);
    }
}

function atualizarDadosPainelWeb(poolDeJogos, alertasDisparadosPorJogo) {
    const listaJogos = [];
    for (let [id, jogo] of poolDeJogos.entries()) {
        const alertas = alertasDisparadosPorJogo.get(id);
        let statusGatilho = "Escaneando...";
        if (jogo.noIntervalo) statusGatilho = "INTERVALO";
        else if (alertas?.golIminente2T)      statusGatilho = "🚨 GATILHO 2T!";
        else if (alertas?.golIminente2TFora)  statusGatilho = "🚨 GATILHO 2T FORA";
        else if (alertas?.favoritoVira)       statusGatilho = "🔄 FAVORITO VIRA";
        else if (alertas?.favoritoVence)      statusGatilho = "💰 FAVORITO VENCE";
        else if (alertas?.golIminente1T)      statusGatilho = "🔥 GATILHO 1T!";
        else if (alertas?.golIminente1TFora)  statusGatilho = "🔥 GATILHO 1T FORA";
        else if (alertas?.layDraw)            statusGatilho = "🏆 LAY DRAW";
        else if (alertas?.lay11)              statusGatilho = "🎯 LAY 1x1";
        else if (alertas?.lay01)              statusGatilho = "⚡ LAY 0x1";
        else if (alertas?.lay10)              statusGatilho = "⚡ LAY 1x0";
        else if (alertas?.lay12)              statusGatilho = "⚡ LAY 1x2";
        else if (alertas?.lay21)              statusGatilho = "⚡ LAY 2x1";
        else if (alertas?.lay00)              statusGatilho = "🔵 LAY 0x0";

        listaJogos.push({
            id,
            nomePartida: jogo.nomePartida,
            tempo: jogo.tempo,
            placar: jogo.placar,
            noIntervalo: jogo.noIntervalo,
            pressao: jogo.pressao,
            xgCasa: jogo.xgCasa,
            xgFora: jogo.xgFora,
            momentum: jogo.momentum,
            statusGatilho,
            posseBolaCasa: jogo.posseBolaCasa || 50,
            posseBolaFora: jogo.posseBolaFora || 50,
            
            // Mapeamento Macro Direto (Evita nós complexos)
            atqPerigososCasa: jogo.ataquesPerigososCasa || 0,
            atqPerigososFora: jogo.ataquesPerigososFora || 0,
            escanteiosCasa: jogo.escanteiosCasa || 0,
            escanteiosFora: jogo.escanteiosFora || 0,
            chutesNoAlvoCasa: jogo.chutesNoAlvoCasa || 0,
            chutesNoAlvoFora: jogo.chutesNoAlvoFora || 0,
            chutesParaForaCasa: jogo.chutesParaForaCasa || 0,
            chutesParaForaFora: jogo.chutesParaForaFora || 0,
            // Odds Betfair (null se não configurado)
            betfairOdds: jogo.betfairOdds || null,
            betfairMarketId: jogo.betfairMarketId || null,
            sofascoreMomentumUrl: jogo.sofascoreMomentumUrl || null,
            sofascoreMomentumImg: jogo.sofascoreMomentumImg || null
        });
    }
    dadosUltimosJogos = listaJogos;
    clientesSSE.forEach(res => { res.write(`data: ${JSON.stringify(listaJogos)}\n\n`); });
}

async function enviarAlertaTelegram(idJogo, jogo, mensagem, metodoAtivado) {
    if (config.TELEGRAM_TOKEN === 'SEU_BOT_TOKEN_AQUI') return;
    try {
        await axios.post(`https://api.telegram.org/bot${config.TELEGRAM_TOKEN}/sendMessage`, { chat_id: config.TELEGRAM_CHAT_ID, text: mensagem, parse_mode: 'Markdown' });
        if (!fs.existsSync(CAMINHO_LOG_CSV)) {
            fs.writeFileSync(CAMINHO_LOG_CSV, "DATA_HORA;PARTIDA;METODO;TEMPO_DISPARO;PLACAR_MOMENTO;APM_MOMENTO;XG_MAX_MOMENTO;QUALIDADE_SINAL;\n", 'utf8');
        }
        // Extrai o valor de Qualidade da mensagem (ex: "Qualidade: 45%" ou "Qualidade máx: 38%")
        const matchQual = mensagem.match(/Qualidade(?:\s+m[aá]x)?:\s*(\d+)%/i);
        const qualidadeSinal = matchQual ? `${matchQual[1]}%` : 'N/D';
        const { data: dataHoje, hora: horaAgora } = _formatarDataHora();
        const linhaLog = `${dataHoje} ${horaAgora};${jogo.nomePartida.replace(/;/g, '-')};${metodoAtivado};${jogo.tempo};${jogo.placar};${jogo.pressao.toFixed(2)};${Math.max(jogo.xgCasa, jogo.xgFora).toFixed(2)};${qualidadeSinal};\n`;
        fs.appendFileSync(CAMINHO_LOG_CSV, linhaLog, 'utf8');
    } catch (e) {}
}

function registrarScreenshotMomentum(jogoId, base64Img) {
    if (jogoId && base64Img) _screenshotsMomentum.set(String(jogoId), base64Img);
}

function removerScreenshotMomentum(jogoId) {
    _screenshotsMomentum.delete(String(jogoId));
}

module.exports = { registrarTelemetriaContinua, enviarAlertaTelegram, atualizarDadosPainelWeb, registrarCallbackAdicionarJogo, registrarScreenshotMomentum, removerScreenshotMomentum };
