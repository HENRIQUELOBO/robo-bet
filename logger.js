// logger.js
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const config = require('./config');
const { formatarDataHora, sanitizarNomeJogo } = require('./util');
const serverHttp = require('./httpServer');

const CAMINHO_LOG_CSV = path.join(__dirname, 'historico_gatilhos.csv');

let clientesSSE = [];
let dadosUltimosJogos = [];
let _callbackAdicionarJogo = null;
// callback holder specifically for per-jogo updates (monitor results)
const _sharedUpdateCallback = { fn: null };
// Mapa de screenshots momentum: { [jogoId]: base64String }
const _screenshotsMomentum = new Map();

// Shared mutable holder so httpServer can call the callback even if it's registered later
const _sharedCallback = { fn: null };

function registrarCallbackAdicionarJogo(fn) {
    _callbackAdicionarJogo = fn;
    _sharedCallback.fn = fn;
}

function registrarCallbackJogoAtualizado(fn) {
    _sharedUpdateCallback.fn = fn;
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
        const { data: dataFormatada, hora: horaMinutoSegundo } = formatarDataHora();
        const nomeJogoSanitizado = sanitizarNomeJogo(nomeEfetivo);
        const pastaTelemetria = path.join(__dirname, 'log', 'telemetria');
        if (!fs.existsSync(pastaTelemetria)) fs.mkdirSync(pastaTelemetria, { recursive: true });

        const caminhoTxt = path.join(pastaTelemetria, `telemetria_${nomeJogoSanitizado}_${dataFormatada}.txt`);
        // Use momentum escanteios (micro10 momentum) when available — preferred for tests
        const escC = (jogo.momentum && typeof jogo.momentum.escanteiosCasa === 'number') ? jogo.momentum.escanteiosCasa : (jogo.escanteiosCasa || 0);
        const escF = (jogo.momentum && typeof jogo.momentum.escanteiosFora === 'number') ? jogo.momentum.escanteiosFora : (jogo.escanteiosFora || 0);
        const linhaLog = `[${horaMinutoSegundo}] | Min: ${jogo.tempo}' | Placar: ${jogo.placar} | APM Max: ${jogo.pressao.toFixed(2)} | xG C: ${jogo.xgCasa.toFixed(2)} - xG F: ${jogo.xgFora.toFixed(2)} | Esc: ${escC}/${escF} | APM10m C/F: ${jogo.momentum.ataquesCasa}/${jogo.momentum.ataquesFora}\n`;
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
            ,
            engineAnalysis: jogo._engineAnalysis || null
        });
    }
    dadosUltimosJogos = listaJogos;
    // sanitize payload: replace any string value that is exactly '-' (or ' - ') with empty string
    function sanitizePayload(obj) {
        if (!obj || typeof obj !== 'object') return obj;
        for (const k of Object.keys(obj)) {
            const v = obj[k];
            if (typeof v === 'string' && v.trim() === '-') obj[k] = '';
            else if (Array.isArray(v)) obj[k] = v.map(x => (typeof x === 'string' && x.trim() === '-') ? '' : x);
            else if (v && typeof v === 'object') sanitizePayload(v);
        }
        return obj;
    }
    listaJogos.forEach(j => sanitizePayload(j));
    // debug: quantos jogos possuem engineAnalysis antes de enviar (temporário)
    try {
        const withAnalysis = listaJogos.filter(j => j.engineAnalysis != null).length;
        console.log(`[LOGGER] Enviando ${listaJogos.length} jogos via SSE — engineAnalysis presente em ${withAnalysis}`);
    } catch (e) { /* ignore logging errors */ }

    // Notify any registered in-process callbacks about jogo updates (used by monitor_results)
    try {
        if (_sharedUpdateCallback && typeof _sharedUpdateCallback.fn === 'function') {
            listaJogos.forEach(j => { try { _sharedUpdateCallback.fn(j); } catch (e) { /* non-fatal */ } });
        }
    } catch (e) { /* ignore */ }

    // broadcast to SSE clients
    clientesSSE.forEach(res => { res.write(`data: ${JSON.stringify(listaJogos)}\n\n`); });
}

// Tornar escrita no CSV assíncrona para não bloquear o loop principal
async function enviarAlertaTelegram(idJogo, jogo, mensagem, metodoAtivado) {
    const fsp = fs.promises;
    // Ensure header exists (create file with header if missing) using async ops
    // Precompute signalId and line so we can notify monitor even if file write fails
    const matchQual = mensagem.match(/Qualidade(?:\s+m[aá]x)?:\s*(\d+)%/i);
    const qualidadeSinal = matchQual ? `${matchQual[1]}%` : 'N/D';
    const { data: dataHoje, hora: horaAgora } = formatarDataHora();
    const signalId = `sig_${Date.now()}_${Math.floor(Math.random()*100000)}`;
    const placarParaCsv = jogo.placar || 'N/D';
    // Prefer momentum escanteios (micro10) for signal snapshot; fall back to jogo totals
    const escC = (jogo.momentum && typeof jogo.momentum.escanteiosCasa === 'number') ? jogo.momentum.escanteiosCasa : (jogo.escanteiosCasa || 0);
    const escF = (jogo.momentum && typeof jogo.momentum.escanteiosFora === 'number') ? jogo.momentum.escanteiosFora : (jogo.escanteiosFora || 0);
    const linhaLog = `${dataHoje} ${horaAgora};${(jogo.nomePartida||'').replace(/;/g, '-')};${metodoAtivado};${jogo.tempo};${placarParaCsv};${(jogo.pressao||0).toFixed(2)};${(Math.max(jogo.xgCasa||0, jogo.xgFora||0)).toFixed(2)};${qualidadeSinal};${escC};${escF};PENDING;${signalId};\n`;

    try {
        try { await fsp.access(CAMINHO_LOG_CSV); } catch (err) {
            const header = "DATA_HORA;PARTIDA;METODO;TEMPO_DISPARO;PLACAR_MOMENTO;APM_MOMENTO;XG_MAX_MOMENTO;QUALIDADE_SINAL;ESC_CASA;ESC_FORA;STATUS;ID;\n";
            await fsp.writeFile(CAMINHO_LOG_CSV, header, 'utf8');
        }

        try {
            await fsp.appendFile(CAMINHO_LOG_CSV, linhaLog, 'utf8');
        } catch (appendErr) {
            // Fallback: try synchronous append to avoid silent loss
            try {
                fs.appendFileSync(CAMINHO_LOG_CSV, linhaLog, 'utf8');
            } catch (syncErr) {
                // rethrow to be handled below, but we still will notify monitor
                throw syncErr;
            }
        }
    } catch (e) {
        process.stderr.write(`[LOGGER ERROR] enviarAlertaTelegram (local write): ${e.message}\n`);
    }

    // Notify monitor in-memory (non-blocking) so it can start observing this signal
    try {
        const monitor = require('./monitor_results');
        if (monitor && typeof monitor.registrarSinalPendente === 'function') {
            monitor.registrarSinalPendente({ id: signalId, jogoId: idJogo, metodo: metodoAtivado, tempoEmissao: jogo.tempo, placar: jogo.placar });
        }
    } catch (ignore) {
        // ignore if monitor not present or errors during require
    }

    // Ensure message includes placar for easier traceability in telegram
    let mensagemParaEnviar = mensagem;
    try {
        const hasPlacar = /placar\s*[:\-]/i.test(mensagem);
        const placarText = jogo.placar || placarParaCsv;
        if (!hasPlacar && placarText) {
            // append small suffix with placar
            mensagemParaEnviar = `${mensagem}\n\n⚽ Placar: ${placarText}`;
        }
    } catch (e) {
        // ignore formatting errors
    }

    // If Telegram token is configured, also send the message to Telegram (best-effort)
    if (config.TELEGRAM_TOKEN && config.TELEGRAM_TOKEN !== 'SEU_BOT_TOKEN_AQUI') {
        try {
            await axios.post(`https://api.telegram.org/bot${config.TELEGRAM_TOKEN}/sendMessage`, { chat_id: config.TELEGRAM_CHAT_ID, text: mensagemParaEnviar, parse_mode: 'Markdown' });
        } catch (e) {
            process.stderr.write(`[LOGGER ERROR] enviarAlertaTelegram (telegram): ${e.message}\n`);
        }
    }
}

function registrarScreenshotMomentum(jogoId, base64Img) {
    if (jogoId && base64Img) _screenshotsMomentum.set(String(jogoId), base64Img);
}

function removerScreenshotMomentum(jogoId) {
    _screenshotsMomentum.delete(String(jogoId));
}

module.exports = { registrarTelemetriaContinua, enviarAlertaTelegram, atualizarDadosPainelWeb, registrarCallbackAdicionarJogo, registrarCallbackJogoAtualizado, registrarScreenshotMomentum, removerScreenshotMomentum };
