// logger.js
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const http = require('http');
const config = require('./config');

const CAMINHO_LOG_CSV = path.join(__dirname, 'historico_gatilhos.csv');

let clientesSSE = [];
let dadosUltimosJogos = [];

const server = http.createServer((req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    if (req.method === 'OPTIONS') { res.writeHead(200); res.end(); return; }

    if (req.url === '/events') {
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' });
        clientesSSE.push(res);
        res.write(`data: ${JSON.stringify(dadosUltimosJogos)}\n\n`);
        req.on('close', () => { clientesSSE = clientesSSE.filter(client => client !== res); });
    } else {
        res.writeHead(404); res.end();
    }
});

server.listen(3000, '0.0.0.0', () => {});

function registrarTelemetriaContinua(jogo) {
    if (!jogo || !jogo.nomePartida || jogo.nomePartida.includes('Carregando')) return;
    try {
        const dataAtual = new Date();
        const dataFormatada = dataAtual.toLocaleDateString('pt-BR').replace(/\//g, '-');
        const horaMinutoSegundo = dataAtual.toLocaleTimeString('pt-BR');
        const nomeJogoSanitizado = jogo.nomePartida.replace(/\s+/g, '_').replace(/[^a-zA-Z0-9_v]/g, '');
        const pastaTelemetria = path.join(__dirname, 'log', 'telemetria');
        if (!fs.existsSync(pastaTelemetria)) fs.mkdirSync(pastaTelemetria, { recursive: true });

        const caminhoTxt = path.join(pastaTelemetria, `telemetria_${nomeJogoSanitizado}_${dataFormatada}.txt`);
        const linhaLog = `[${horaMinutoSegundo}] | Min: ${jogo.tempo}' | Placar: ${jogo.placar} | APM Max: ${jogo.pressao.toFixed(2)} | xG C: ${jogo.xgCasa.toFixed(2)} - xG F: ${jogo.xgFora.toFixed(2)} | APM10m C/F: ${jogo.momentum.ataquesCasa}/${jogo.momentum.ataquesFora}\n`;
        fs.appendFileSync(caminhoTxt, linhaLog, 'utf8');
    } catch (err) {}
}

function atualizarDadosPainelWeb(poolDeJogos, alertasDisparadosPorJogo) {
    const listaJogos = [];
    for (let [id, jogo] of poolDeJogos.entries()) {
        const alertas = alertasDisparadosPorJogo.get(id);
        let statusGatilho = "Escaneando...";
        if (jogo.noIntervalo) statusGatilho = "INTERVALO";
        else if (alertas?.golIminente2T) statusGatilho = "🚨 GATILHO 2T!";
        else if (alertas?.golIminente1T) statusGatilho = "🔥 GATILHO 1T!";

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
            chutesParaForaFora: jogo.chutesParaForaFora || 0
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
            fs.writeFileSync(CAMINHO_LOG_CSV, "DATA_HORA;PARTIDA;METODO;TEMPO_DISPARO;PLACAR_MOMENTO;APM_MOMENTO;XG_MAX_MOMENTO;\n", 'utf8');
        }
        const linhaLog = `${new Date().toLocaleString('pt-BR')};${jogo.nomePartida.replace(/;/g, '-')};${metodoAtivado};${jogo.tempo};${jogo.placar};${jogo.pressao.toFixed(2)};\n`;
        fs.appendFileSync(CAMINHO_LOG_CSV, linhaLog, 'utf8');
    } catch (e) {}
}

module.exports = { registrarTelemetriaContinua, enviarAlertaTelegram, atualizarDadosPainelWeb };