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
            // find the line where one of the fields exactly equals the signalId
            const parts = lines[i].split(';');
            const idIndex = parts.findIndex(p => p === signalId);
            if (idIndex !== -1) {
                // assume STATUS is the field immediately before ID (idIndex-1)
                const statusIndex = Math.max(0, idIndex - 1);
                // Only update the STATUS field to the canonical values (GREEN/RED/EXPIRED)
                parts[statusIndex] = String(novoStatus || '').toUpperCase();
                // Remove any stray textual notes that may have been accidentally placed in the STATUS column
                // and ensure we do NOT write arbitrary info into the CSV. We intentionally DO NOT write `info` here.
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
        // If the game entered half-time, evaluate pending 1T signals and resolve them.
        if (jogo.noIntervalo) {
            for (const [id, s] of Array.from(pendentes.entries())) {
                if (String(s.jogoId) === String(jogo.id)) {
                    const metodoLow = (s.metodo || '').toLowerCase();
                    if (metodoLow.includes('gatilho_1t') || metodoLow.includes('gatilho_1t_fora') || metodoLow.includes('1t')) {
                        try {
                            const antes = (s.placar || '0-0').split('-').map(Number);
                            const agora = (jogo.placar || '0-0').split('-').map(Number);
                            const gCAnt = antes[0]||0, gFAnt = antes[1]||0;
                            const gCNow = agora[0]||0, gFNow = agora[1]||0;
                            // If there was a favorable score change before interval, mark GREEN; otherwise RED.
                            if (gCNow > gCAnt) {
                                // home scored
                                if (metodoLow.includes('fora')) atualizarStatusCSV(id, 'RED');
                                else atualizarStatusCSV(id, 'GREEN');
                            } else if (gFNow > gFAnt) {
                                // away scored
                                if (metodoLow.includes('fora')) atualizarStatusCSV(id, 'GREEN');
                                else atualizarStatusCSV(id, 'RED');
                            } else {
                                // no scoring change -> mark RED for 1T
                                atualizarStatusCSV(id, 'RED', 'intervalo');
                            }
                        } catch (ex) {
                            atualizarStatusCSV(id, 'RED', 'intervalo_error');
                        }
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
                // Stronger rule for LAY_DRAW: if draw state changed (either draw->not-draw or not-draw->draw)
                // resolve immediately: draw->not-draw = GREEN (lay succeeded), not-draw->draw = RED (lay failed)
                if (metodoLow.includes('draw') || metodoLow.includes('lay_draw') || metodoLow.includes('lay draw')) {
                    if (antesFoiEmpate !== agoraEhEmpate) {
                        if (antesFoiEmpate && !agoraEhEmpate) {
                            atualizarStatusCSV(id, 'GREEN', 'lay_draw_goal');
                        } else {
                            atualizarStatusCSV(id, 'RED', 'lay_draw_now_draw');
                        }
                        pendentes.delete(id);
                        continue;
                    }
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

module.exports = { registrarSinalPendente };
