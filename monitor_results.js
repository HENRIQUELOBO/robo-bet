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
                // linha encontrada — substitui STATUS e preserva ID. CSV layout now:
                // 0:DATA_HORA;1:PARTIDA;2:METODO;3:TEMPO;4:PLACAR;5:APM;6:XG;7:QUAL;8:ESC_CASA;9:ESC_FORA;10:STATUS;11:ID;12:INFO
                const parts = lines[i].split(';');
                // safe: ensure array long enough for indexes up to 12
                while (parts.length < 13) parts.push('');
                parts[10] = novoStatus; // STATUS index (0-based after adding esc fields)
                // place info into dedicated INFO column to avoid shifting fields
                if (info) parts[12] = info;
                lines[i] = parts.join(';');
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
    // Se o jogo entrou no intervalo, resolver imediatamente sinais de 1T pendentes como RED
    try {
        if (jogo.noIntervalo) {
            for (const [id, s] of Array.from(pendentes.entries())) {
                if (String(s.jogoId) === String(jogo.id)) {
                    const metodoLow = (s.metodo || '').toLowerCase();
                    if (metodoLow.includes('gatilho_1t') || metodoLow.includes('gatilho_1t_fora') || metodoLow.includes('1t')) {
                        atualizarStatusCSV(id, 'RED', 'intervalo');
                        pendentes.delete(id);
                    }
                }
            }
        }
    } catch (e) { /* non-fatal */ }
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
                // Special case: LAY_DRAW (lay against draw) -> if before was draw and now not draw -> GREEN
                const metodoLow = (s.metodo || '').toLowerCase();
                const antesFoiEmpate = (gCAnt === gFAnt);
                const agoraEhEmpate = (gCNow === gFNow);
                if (metodoLow.includes('draw') || metodoLow.includes('lay_draw') || metodoLow.includes('lay draw')) {
                    // if previously draw and now not draw => GREEN (draw eliminated)
                    if (antesFoiEmpate && !agoraEhEmpate) {
                        atualizarStatusCSV(id, 'GREEN', 'lay_draw_goal');
                        pendentes.delete(id);
                        continue;
                    }
                    // otherwise, if became draw at end -> RED handled in end-of-match block below
                }

                let resolved = false;
                // basic inference from metodo string
                const metodo = metodoLow;
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
            // NOTE: original logic accidentally checked !pendentes.has(id) which prevented expiration.
            if (pendentes.has(id) && jogo.noIntervalo && jogo.tempo > 90) {
                // partida terminou: avaliar placar final para decidir GREEN/RED
                try {
                    const metodoLow = (s.metodo || '').toLowerCase();
                    const antes = (s.placar || '0-0').split('-').map(Number);
                    const final = (jogo.placar || '0-0').split('-').map(Number);
                    const gCAnt = antes[0]||0, gFAnt = antes[1]||0;
                    const gCNow = final[0]||0, gFNow = final[1]||0;
                    let decided = false;
                    // If metod is LAY_DRAW: if final is not draw => GREEN, else RED
                    if (metodoLow.includes('draw') || metodoLow.includes('lay_draw') || metodoLow.includes('lay draw')) {
                        if (gCNow !== gFNow) { atualizarStatusCSV(id, 'GREEN'); decided = true; }
                        else { atualizarStatusCSV(id, 'RED'); decided = true; }
                    }
                    // proceed with other heuristics only if not decided
                    if (!decided) {
                        // If home increased goals and method favors home -> GREEN
                        if (gCNow > gCAnt) {
                            if (metodoLow.includes('casa') || metodoLow.includes('favorito') || metodoLow.includes('back')) {
                                atualizarStatusCSV(id, 'GREEN'); decided = true;
                            }
                        }
                        // If away increased and method favors away -> GREEN
                        if (!decided && gFNow > gFAnt) {
                            if (metodoLow.includes('fora') || metodoLow.includes('favorito') || metodoLow.includes('back')) {
                                atualizarStatusCSV(id, 'GREEN'); decided = true;
                            }
                        }
                        // Exact-score match (e.g., LAY_0x1) -> GREEN
                        if (!decided) {
                            const m = s.metodo || '';
                            const scoreMatch = m.match(/(\d+)[x-](\d+)/);
                            if (scoreMatch) {
                                const exC = parseInt(scoreMatch[1],10)||0;
                                const exF = parseInt(scoreMatch[2],10)||0;
                                if (exC === gCNow && exF === gFNow) { atualizarStatusCSV(id, 'GREEN'); decided = true; }
                            }
                        }
                    }
                    if (!decided) { atualizarStatusCSV(id, 'RED'); }
                } catch (e) {
                    atualizarStatusCSV(id, 'EXPIRED');
                }
                pendentes.delete(id);
            }
        }
    }
}

// registra callback no logger para receber atualizações
try {
    // register as jogo-updated listener (use new API)
    if (typeof logger.registrarCallbackJogoAtualizado === 'function') {
        logger.registrarCallbackJogoAtualizado(onJogoAtualizado);
    } else {
        // fallback for older logger versions
        logger.registrarCallbackAdicionarJogo(onJogoAtualizado);
    }
} catch (e) {
    // ignore if registration fails
}

module.exports = { registrarSinalPendente, onJogoAtualizado };
