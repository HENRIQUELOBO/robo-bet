// logger.js
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const config = require('./config');
const {_formatarDataHora, _sanitizarNomeJogo} = require('./util');
const serverHttp = require('./httpServer');

const CAMINHO_LOG_CSV = path.join(__dirname, 'historico_gatilhos.csv');

let clientesSSE = [];
let dadosUltimosJogos = [];
let _callbackAdicionarJogo = null;
// Mapa de screenshots momentum: { [jogoId]: base64String }
const _screenshotsMomentum = new Map();

// Shared mutable holder so httpServer can call the callback even if it's registered later
const _sharedCallback = { fn: null };

function registrarCallbackAdicionarJogo(fn) {
    _callbackAdicionarJogo = fn;
    _sharedCallback.fn = fn;
}

// Passa uma função getter para que o servidor HTTP possa obter sempre
// o estado mais recente de `dadosUltimosJogos` mesmo após reloads do front-end.
serverHttp({
    clientesSSE,
    getDadosUltimosJogos: () => dadosUltimosJogos,
    _callbackAdicionarJogo: _sharedCallback,
    _screenshotsMomentum
});

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

const GATILHO_STATUS_MAP = {
    golIminente2T: "🚨 GATILHO 2T!",
    golIminente2TFora: "🚨 GATILHO 2T FORA",
    favoritoVira: "🔄 FAVORITO VIRA",
    favoritoVence: "💰 FAVORITO VENCE",
    golIminente1T: "🔥 GATILHO 1T!",
    golIminente1TFora: "🔥 GATILHO 1T FORA",
    layDraw: "🏆 LAY DRAW",
    lay11: "🎯 LAY 1x1",
    lay01: "⚡ LAY 0x1",
    lay10: "⚡ LAY 1x0",
    lay12: "⚡ LAY 1x2",
    lay21: "⚡ LAY 2x1",
    lay00: "🔵 LAY 0x0",
};

function atualizarDadosPainelWeb(poolDeJogos, alertasDisparadosPorJogo) {
    const listaJogos = [];
    for (let [id, jogo] of poolDeJogos.entries()) {
        const alertas = alertasDisparadosPorJogo.get(id);
        let statusGatilho = "Escaneando...";

        if (jogo.noIntervalo) {
            statusGatilho = "INTERVALO";
        } else if (alertas) {
            // Itera sobre o mapa de status para encontrar o primeiro gatilho ativo
            for (const key in GATILHO_STATUS_MAP) {
                if (alertas[key]) {
                    statusGatilho = GATILHO_STATUS_MAP[key];
                    break; // Encontrou o primeiro, pode sair
                }
            }
        }

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
