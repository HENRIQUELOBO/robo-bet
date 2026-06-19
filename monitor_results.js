// monitor_results.js
// Monitora sinais PENDING e atualiza CSV quando o placar muda ou jogo acaba.

const fs = require('fs');
const path = require('path');
const logger = require('./logger');

const CAMINHO_LOG_CSV = path.join(__dirname, 'historico_gatilhos.csv');

// mapa: signalId -> { id, jogoId, metodo, tempoEmissao, placarEmissao, criadoEm }
const pendentes = new Map();

// registra sinal pendente vindo do logger
function registrarSinalPendente(signal) {
    if (!signal || !signal.id) return;
    pendentes.set(signal.id, { ...signal, criadoEm: Date.now() });
}

// helper para atualizar a linha do CSV trocando STATUS e adicionando tempoResultado
function atualizarStatusCSV(signalId, novoStatus, info = '') {
    try {
        if (!fs.existsSync(CAMINHO_LOG_CSV)) return false;
        const txt = fs.readFileSync(CAMINHO_LOG_CSV, 'utf8');
        const lines = txt.split('\n');
        let changed = false;
        for (let i = 0; i < lines.length; i++) {
            if (lines[i].includes(`${signalId};`)) {
                // linha encontrada — substitui STATUS (campo 9) por novoStatus e anexa info
                const parts = lines[i].split(';');
                // safe: ensure array long enough
                while (parts.length < 10) parts.push('');
                parts[8] = novoStatus; // STATUS index (0-based)
                // optionally add info after ID
                lines[i] = parts.join(';') + (info ? `;${info}` : '');
                changed = true;
                break;
            }
        }
        if (changed) {
            fs.writeFileSync(CAMINHO_LOG_CSV, lines.join('\n'), 'utf8');
        }
        return changed;
    } catch (e) {
        process.stderr.write(`[MONITOR ERROR] atualizarStatusCSV: ${e.message}\n`);
        return false;
    }
}

// callback que será chamado com o objeto jogo atualizado
function onJogoAtualizado(jogo) {
    if (!jogo || !jogo.id) return;
    // percorre pendentes que correspondem a este jogo
    for (const [id, s] of Array.from(pendentes.entries())) {
        if (s.jogoId == jogo.id || s.jogoId === jogo.id || String(s.jogoId) === String(jogo.id)) {
            // decide: se placar mudou desde emissão e favorável => GREEN; se adversário marcou => RED
            const placarAntes = s.placar || '';
            const placarAgora = jogo.placar || '';
            if (placarAntes !== placarAgora) {
                // parse placar "gC-gF"
                const pa = (placarAntes || '0-0').split('-').map(Number);
                const pb = (placarAgora || '0-0').split('-').map(Number);
                const gCAnt = pa[0]||0; const gFAnt = pa[1]||0;
                const gCNow = pb[0]||0; const gFNow = pb[1]||0;
                // if home scored and before home was dominant assume GREEN for home signals
                // Simples heurística: se gol do time que antes estava a perder/empatar e é coerente com metodo
                // Para agora: se total de gols aumentou e mudança favorável para quem estava sendo recomendado -> GREEN
                // We'll consider any goal by either side: if scoring side equalizes/gets advantage then GREEN if it's the team expected.

                // Heuristic: if gCNow > gCAnt and metodo mentions 'CASA' or signal placar indicates home advantage, mark GREEN; vice-versa for away.
                let resolved = false;
                // basic inference from metodo string
                const metodo = (s.metodo || '').toLowerCase();
                if (gCNow > gCAnt) {
                    if (metodo.includes('casa') || metodo.includes('favorito') || metodo.includes('back')) {
                        atualizarStatusCSV(id, 'GREEN');
                    } else {
                        atualizarStatusCSV(id, 'RED');
                    }
                    resolved = true;
                } else if (gFNow > gFAnt) {
                    if (metodo.includes('fora') || metodo.includes('favorito') || metodo.includes('back')) {
                        atualizarStatusCSV(id, 'GREEN');
                    } else {
                        atualizarStatusCSV(id, 'RED');
                    }
                    resolved = true;
                }

                if (resolved) pendentes.delete(id);
            }
            // if jogo finished (noIntervalo true and tempo > 90) or other end condition
            if (!pendentes.has(id) && jogo.noIntervalo && jogo.tempo > 90) {
                // mark expired if still present
                if (pendentes.has(id)) {
                    atualizarStatusCSV(id, 'EXPIRED');
                    pendentes.delete(id);
                }
            }
        }
    }
}

// registra callback no logger para receber atualizações
try {
    logger.registrarCallbackAdicionarJogo(onJogoAtualizado);
} catch (e) {
    // ignore if registration fails
}

module.exports = { registrarSinalPendente, onJogoAtualizado };

