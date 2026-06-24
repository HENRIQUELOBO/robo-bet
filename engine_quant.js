function calcularPressaoAPM(
    historico, tempoAtual) {
    if (tempoAtual <= 0) return 0;
    const limite = Math.max(0, tempoAtual - 5);
    return contarMaiorQueReverse(historico, limite) / 5;
}

function calcularMomentumMicro10(historico, tempoAtual) {
    if (tempoAtual <= 0) return 0;
    const limite = Math.max(0, tempoAtual - 10);
    return contarMaiorQueReverse(historico, limite);
}

function calcularAceleracao(historico, tempoAtual) {
    if (tempoAtual < 5) return 0;
    const l5  = Math.max(0, tempoAtual - 5);
    const l10 = Math.max(0, tempoAtual - 10);
    // count recent > l5 and count in (l10, l5]
    const last5 = contarMaiorQueReverse(historico, l5);
    let prev5 = 0;
    if (historico && historico.length) {
        for (let i = historico.length - 1; i >= 0; i--) {
            const t = historico[i];
            if (t > l5) continue;
            if (t > l10) prev5++;
            else break;
        }
    }
    return last5 - prev5;
}

// Efficient reverse-iteration counter: assumes timestamps ascending (old..new)
function contarMaiorQueReverse(arr, limite) {
    if (!arr || arr.length === 0) return 0;
    let c = 0;
    for (let i = arr.length - 1; i >= 0; i--) {
        if (arr[i] > limite) c++; else break;
    }
    return c;
}

/** Parse seguro do placar "G-G" → { gC, gF } */
function parsePlacar(placar) {
    const p = (placar || '0-0').split('-').map(Number);
    return { gC: p[0] || 0, gF: p[1] || 0 };
}

const { createAnalyzer } = require('./engine_analysis');

// --- QUANT HELPERS INSERTED BEGIN ---
const QUANT_CONFIG = {
    acelThreshold: 1,
    sustainedWindow: 3,
    apmPressureThreshold: 0.4,
    ataqueThreshold2T: 12,
    chEscThreshold2T: 3,
    qualThreshold2T: 0.18,
    weights: { acel: 0.25, apm: 0.20, qual: 0.20, xgMoment: 0.20, market: 0.10 },
    scoreThreshold: 0.6
};
function clamp01(v) { return Math.max(0, Math.min(1, v)); }
function calcularAceleracaoNormalizada(historico, tempoAtual) { const ac = calcularAceleracao(historico, tempoAtual); const limite = Math.max(0, tempoAtual - 10); const ataques10 = contarMaiorQueReverse(historico, limite); return ataques10 > 0 ? ac / ataques10 : (ac>0? 1 : 0); }
function isSustainedPressure(jogo, team) { const key = team === 'casa' ? '_pressureWindowCasa' : '_pressureWindowFora'; const arr = jogo[key] || []; if (arr.length < QUANT_CONFIG.sustainedWindow) return false; const truths = arr.filter(Boolean).length; return truths >= Math.ceil(QUANT_CONFIG.sustainedWindow * 0.66); }
// --- QUANT HELPERS INSERTED END ---

function processarMotorDeRegras(idJogo, jogo, alertas) {
    const minAtual = jogo.tempo;
    // per-invocation analyzer instance collects diagnostics and decisions
    // and will be attached to the jogo object as `_engineAnalysis` so
    // the rest of the system (logger / UI) can inspect it.
    const analyzer = createAnalyzer();

    // --- PERF: cache counts used multiple times in this tick (avoid repeated filters)
    const now = minAtual;
    const last5 = Math.max(0, now - 5);
    const last10 = Math.max(0, now - 10);
    const countWindow = (arr, lowerExclusive, upperInclusive = Infinity) => {
        if (!arr || arr.length === 0) return 0;
        let c = 0;
        for (let i = arr.length - 1; i >= 0; i--) {
            const t = arr[i];
            if (t > lowerExclusive && t <= upperInclusive) c++;
            else if (t <= lowerExclusive) break;
        }
        return c;
    };

    // common cached counts
    const chAlvoCasa_last5 = countWindow(jogo.historicoChAlvoCasa, last5, Infinity);
    const chAlvoCasa_prev5 = countWindow(jogo.historicoChAlvoCasa, last10, last5);
    const chAlvoFora_last5 = countWindow(jogo.historicoChAlvoFora, last5, Infinity);
    const chAlvoFora_prev5 = countWindow(jogo.historicoChAlvoFora, last10, last5);

    // engine entry - no debug logging (kept silent)
    // 🔬 TRAVA ANTI-FANTASMA DO INTERVALO
    if (jogo.noIntervalo && !jogo.momentumResetado2T) {
        jogo.historicoAtqCasa = []; jogo.historicoAtqFora = [];
        jogo.historicoEscCasa = []; jogo.historicoEscFora = [];
        jogo.historicoChAlvoCasa = []; jogo.historicoChAlvoFora = [];
        jogo.historicoChForaCasa = []; jogo.historicoChForaFora = [];
        jogo.momentum = {
            ataquesCasa: 0, ataquesFora: 0, escanteiosCasa: 0, escanteiosFora: 0,
            chutesNoAlvoCasa: 0, chutesNoAlvoFora: 0, chutesParaForaCasa: 0, chutesParaForaFora: 0
        };

        // Limpa todos os alertas disparados no primeiro tempo para o reinício no segundo tempo
        if (alertas) {
            Object.keys(alertas).forEach(k => { alertas[k] = false; });
        }

        jogo.momentumResetado2T = true;
    }
    if (!jogo.noIntervalo && minAtual > 45 && jogo.momentumResetado2T) jogo.momentumResetado2T = false;

    // --- BLOCO MATEMÁTICO CORE ---
    const apmCasa = calcularPressaoAPM(jogo.historicoAtqCasa, minAtual);
    const apmFora = calcularPressaoAPM(jogo.historicoAtqFora, minAtual);
    jogo.pressao  = apmCasa + apmFora;

    const mapeamentoMomentum = {
        ataquesCasa: jogo.historicoAtqCasa,
        ataquesFora: jogo.historicoAtqFora,
        escanteiosCasa: jogo.historicoEscCasa,
        escanteiosFora: jogo.historicoEscFora,
        chutesNoAlvoCasa: jogo.historicoChAlvoCasa,
        chutesNoAlvoFora: jogo.historicoChAlvoFora,
        chutesParaForaCasa: jogo.historicoChForaCasa,
        chutesParaForaFora: jogo.historicoChForaFora
    };

    for (const [key, historico] of Object.entries(mapeamentoMomentum)) {
        jogo.momentum[key] = calcularMomentumMicro10(historico, minAtual);
    }

    const pesoChAlvo = 0.35; const pesoChFora = 0.15;
    const pesoEsc = 0.08;    const pesoAtq = 0.02;

    jogo.xgCasa = (jogo.historicoChAlvoCasa.length * pesoChAlvo) + (jogo.historicoChForaCasa.length * pesoChFora)
                + (jogo.historicoEscCasa.length * pesoEsc) + (jogo.historicoAtqCasa.length * pesoAtq);
    jogo.xgFora = (jogo.historicoChAlvoFora.length * pesoChAlvo) + (jogo.historicoChForaFora.length * pesoChFora)
                + (jogo.historicoEscFora.length * pesoEsc) + (jogo.historicoAtqFora.length * pesoAtq);

    // --- ENGINE DE DISPARO DE ALERTAS ---
    if (!jogo.noIntervalo && alertas) {

        const { gC, gF } = parsePlacar(jogo.placar);
        const difGols = gC - gF;
        const acCasa  = calcularAceleracao(jogo.historicoAtqCasa, minAtual);
        const acFora  = calcularAceleracao(jogo.historicoAtqFora, minAtual);

        // Ratio de qualidade (chutes no alvo + escanteios por ataque perigoso)
        const qualCasa = jogo.momentum.ataquesCasa > 0
            ? (jogo.momentum.chutesNoAlvoCasa + jogo.momentum.escanteiosCasa) / jogo.momentum.ataquesCasa : 0;
        const qualFora = jogo.momentum.ataquesFora > 0
            ? (jogo.momentum.chutesNoAlvoFora + jogo.momentum.escanteiosFora) / jogo.momentum.ataquesFora : 0;

        // ─────────────────────────────────────────────────────────────────
        // 🔄 SISTEMA DE RE-ARME: Quando o placar muda, reseta os alertas LAY
        // que já não correspondem ao estado atual do jogo.
        // Cooldown de 4 minutos evita re-disparo imediato no caos pós-golo.
        // ─────────────────────────────────────────────────────────────────
        const placarActual = jogo.placar;
        if (jogo._placarSnapshot && jogo._placarSnapshot !== placarActual) {
            const cooldownAte = minAtual + 4;
            jogo._cooldownAteMinuto = cooldownAte;
            // Re-arma LAY cujo score já não coincide com o estado actual
            if (alertas.lay00 && (gC > 0 || gF > 0))            alertas.lay00  = false;
            if (alertas.lay01 && !(gC === 0 && gF === 1))        alertas.lay01  = false;
            if (alertas.lay10 && !(gC === 1 && gF === 0))        alertas.lay10  = false;
            if (alertas.lay11 && !(gC === 1 && gF === 1))        alertas.lay11  = false;
            if (alertas.lay12 && !(gC === 1 && gF === 2))        alertas.lay12  = false;  // FIX: estava em falta
            if (alertas.lay21 && !(gC === 2 && gF === 1))        alertas.lay21  = false;  // FIX: estava em falta
            if (alertas.layDraw && gC !== gF)                    alertas.layDraw = false; // FIX: estava em falta — reseta quando sai do empate
            if (alertas.golIminente2TFora && difGols > 0)        alertas.golIminente2TFora = false;
        }
        jogo._placarSnapshot = placarActual;

        // Respeita cooldown de 4 minutos após golo
        const emCooldown = minAtual < (jogo._cooldownAteMinuto || 0);

        // ─────────────────────────────────────────────────────────────────
        // MÉTODO 1 — GATILHO 1T CASA: Casa pressiona no 1ºT (15'–40')
        // Score: casa a perder, empate, ou a ganhar por apenas 1
        // ─────────────────────────────────────────────────────────────────
        if (!emCooldown && minAtual >= 15 && minAtual <= 40 && !alertas.golIminente1T) {
            if (difGols <= 1 &&
                jogo.momentum.ataquesCasa >= 10 && jogo.momentum.chutesNoAlvoCasa >= 2 &&
                acCasa >= 0 && qualCasa >= 0.15) {
                alertas.golIminente1T = true;
                analyzer.setMet('GATILHO_1T');
                const ctx = difGols < 0 ? '🔴 Casa a perder' : difGols === 0 ? '🟡 Empate' : '🟢 Casa +1';
                const posse = jogo.posseBolaCasa ? ` | Posse Casa: ${jogo.posseBolaCasa}%` : '';
                const msg = `🔥 *WOLF QUANT - GATILHO 1T CASA*\n🏟️ ${jogo.nomePartida}\n⏱️ ${minAtual}' | ${ctx}${posse}\n📊 APM Casa: ${apmCasa.toFixed(2)} | Aceleração: ${acCasa > 0 ? '+' : ''}${acCasa} | xG: ${jogo.xgCasa.toFixed(2)}-${jogo.xgFora.toFixed(2)}\n🔬 AtqP: ${jogo.momentum.ataquesCasa} | Chutes Alvo: ${jogo.momentum.chutesNoAlvoCasa} | Qualidade: ${(qualCasa*100).toFixed(0)}%`;
                require('./logger').enviarAlertaTelegram(idJogo, jogo, msg, "GATILHO_1T");
            }
        }
        analyzer.init('GATILHO_1T');
        // mark why the gatilho is missing, include current values for better diagnostics
        if (emCooldown) analyzer.addMissing('GATILHO_1T', 'emCooldown', minAtual);
        // padrão: marcar janelaTempo com o tempo atual formatado quando fora da janela (formato esperado pelo painel)
        if (minAtual < 15 || minAtual > 40) analyzer.addMissing('GATILHO_1T', 'janelaTempo', `${minAtual}'`);
        if (difGols > 1) analyzer.addMissing('GATILHO_1T', 'difGols>1', difGols);
        if (jogo.momentum.ataquesCasa < 10) analyzer.addMissing('GATILHO_1T', 'ataquesCasa<10', jogo.momentum.ataquesCasa);
        if (jogo.momentum.chutesNoAlvoCasa < 2) analyzer.addMissing('GATILHO_1T', 'chutesNoAlvoCasa<2', jogo.momentum.chutesNoAlvoCasa);
        if (acCasa < 0) analyzer.addMissing('GATILHO_1T', 'aceleracaoNegativa', acCasa);
        if (qualCasa < 0.15) analyzer.addMissing('GATILHO_1T', 'qualidadeBaixa', Math.round(qualCasa*100));
        if (!emCooldown && minAtual >= 15 && minAtual <= 40 && !alertas.golIminente1T && analyzer.get()['GATILHO_1T'].missing.length === 0) {
            alertas.golIminente1T = true;
            analyzer.setMet('GATILHO_1T');
            const ctx = difGols < 0 ? '🔴 Casa a perder' : difGols === 0 ? '🟡 Empate' : '🟢 Casa +1';
            const posse = jogo.posseBolaCasa ? ` | Posse Casa: ${jogo.posseBolaCasa}%` : '';
            const msg = `🔥 *WOLF QUANT - GATILHO 1T CASA*\n🏟️ ${jogo.nomePartida}\n⏱️ ${minAtual}' | ${ctx}${posse}\n📊 APM Casa: ${apmCasa.toFixed(2)} | Aceleração: ${acCasa > 0 ? '+' : ''}${acCasa} | xG: ${jogo.xgCasa.toFixed(2)}-${jogo.xgFora.toFixed(2)}\n🔬 AtqP: ${jogo.momentum.ataquesCasa} | Chutes Alvo: ${jogo.momentum.chutesNoAlvoCasa} | Qualidade: ${(qualCasa*100).toFixed(0)}%`;
            require('./logger').enviarAlertaTelegram(idJogo, jogo, msg, "GATILHO_1T");
        }

        // ─────────────────────────────────────────────────────────────────
        // MÉTODO 2 — GATILHO 1T FORA: Fora pressiona no 1ºT (15'–40')
        // Score: fora a perder, empate, fora a ganhar por 1, OU casa a ganhar
        //        por até 3 (FIX: antes sem limite superior → disparava com 5-0)
        // ─────────────────────────────────────────────────────────────────
        if (!emCooldown && minAtual >= 15 && minAtual <= 40 && !alertas.golIminente1TFora) {
            if (difGols >= -1 && difGols <= 3 &&   // FIX: limite superior adicionado
                jogo.momentum.ataquesFora >= 10 && jogo.momentum.chutesNoAlvoFora >= 2 &&
                acFora >= 0 && qualFora >= 0.15) {
                alertas.golIminente1TFora = true;
                analyzer.setMet('GATILHO_1T_FORA');
                const ctx = difGols > 0 ? '🔴 Fora a perder' : difGols === 0 ? '🟡 Empate' : '🟢 Fora +1';
                const posse = jogo.posseBolaFora ? ` | Posse Fora: ${jogo.posseBolaFora}%` : '';
                const msg = `🔥 *WOLF QUANT - GATILHO 1T FORA*\n🏟️ ${jogo.nomePartida}\n⏱️ ${minAtual}' | ${ctx}${posse}\n📊 APM Fora: ${apmFora.toFixed(2)} | Aceleração: ${acFora > 0 ? '+' : ''}${acFora} | xG: ${jogo.xgCasa.toFixed(2)}-${jogo.xgFora.toFixed(2)}\n🔬 AtqP Fora: ${jogo.momentum.ataquesFora} | Chutes Alvo: ${jogo.momentum.chutesNoAlvoFora} | Qualidade: ${(qualFora*100).toFixed(0)}%`;
                require('./logger').enviarAlertaTelegram(idJogo, jogo, msg, "GATILHO_1T_FORA");
            }
        }
        analyzer.init('GATILHO_1T_FORA');
        // diagnostics with current values
        if (emCooldown) analyzer.addMissing('GATILHO_1T_FORA', 'emCooldown', minAtual);
        // padrão: marcar janelaTempo com o tempo atual formatado quando fora da janela (formato esperado pelo painel)
        if (minAtual < 15 || minAtual > 40) analyzer.addMissing('GATILHO_1T_FORA', 'janelaTempo', `${minAtual}'`);
        if (difGols < -1 || difGols > 3) analyzer.addMissing('GATILHO_1T_FORA', 'difGolsFora', difGols);
        if (jogo.momentum.ataquesFora < 10) analyzer.addMissing('GATILHO_1T_FORA', 'ataquesFora<10', jogo.momentum.ataquesFora);
        if (jogo.momentum.chutesNoAlvoFora < 2) analyzer.addMissing('GATILHO_1T_FORA', 'chutesNoAlvoFora<2', jogo.momentum.chutesNoAlvoFora);
        if (acFora < 0) analyzer.addMissing('GATILHO_1T_FORA', 'aceleracaoNegativa', acFora);
        if (qualFora < 0.15) analyzer.addMissing('GATILHO_1T_FORA', 'qualidadeBaixa', Math.round(qualFora*100));
        if (!emCooldown && minAtual >= 15 && minAtual <= 40 && !alertas.golIminente1TFora && analyzer.get()['GATILHO_1T_FORA'].missing.length === 0) {
            alertas.golIminente1TFora = true;
            analyzer.setMet('GATILHO_1T_FORA');
            const ctx = difGols > 0 ? '🔴 Fora a perder' : '🟡 Empate';
            const posse = jogo.posseBolaFora ? ` | Posse Fora: ${jogo.posseBolaFora}%` : '';
            const msg = `🔥 *WOLF QUANT - GATILHO 1T FORA*\n🏟️ ${jogo.nomePartida}\n⏱️ ${minAtual}' | ${ctx}${posse}\n📊 APM Fora: ${apmFora.toFixed(2)} | Aceleração: ${acFora > 0 ? '+' : ''}${acFora} | xG: ${jogo.xgCasa.toFixed(2)}-${jogo.xgFora.toFixed(2)}\n🔬 AtqP Fora: ${jogo.momentum.ataquesFora} | Chutes Alvo: ${jogo.momentum.chutesNoAlvoFora} | Qualidade: ${(qualFora*100).toFixed(0)}%`;
            require('./logger').enviarAlertaTelegram(idJogo, jogo, msg, "GATILHO_1T_FORA");
        }
        // (analysis will be attached after all methods are evaluated)

        // ─────────────────────────────────────────────────────────────────
        // MÉTODO 3 — GATILHO 2T CASA: Casa pressiona no 2ºT (58'–85')
        // Score: casa a perder ou empate (sem valor se já a ganhar)
        // ─────────────────────────────────────────────────────────────────
        analyzer.init('GATILHO_2T');
        if (!emCooldown && minAtual >= 46 && minAtual <= 85 && !alertas.golIminente2T) {
            if (difGols <= 0) {
                const acelNorm = clamp01(calcularAceleracaoNormalizada(jogo.historicoAtqCasa, minAtual));
                const apmNorm  = clamp01(apmCasa / 1.5);
                const qualVal  = jogo.momentum.ataquesCasa > 0 ? (jogo.momentum.chutesNoAlvoCasa + jogo.momentum.escanteiosCasa) / jogo.momentum.ataquesCasa : null;
                const qualNorm = qualVal != null ? clamp01((qualVal - 0.05) / (0.4 - 0.05)) : 0;
                let xgMomentNorm = 0;
                try {
                    // use cached counts computed above to avoid filters
                    const chLast5 = (typeof chAlvoCasa_last5 !== 'undefined') ? chAlvoCasa_last5 : contarMaiorQueReverse(jogo.historicoChAlvoCasa, Math.max(0, minAtual - 5));
                    const chPrev5 = (typeof chAlvoCasa_prev5 !== 'undefined') ? chAlvoCasa_prev5 : (contarMaiorQueReverse(jogo.historicoChAlvoCasa, Math.max(0, minAtual - 10)) - chLast5);
                    const deltaCh = chLast5 - chPrev5;
                    xgMomentNorm = clamp01((deltaCh + 1) / 3);
                } catch (e) { xgMomentNorm = 0; }

                const marketSignal = (() => {
                    const odds = jogo.betfairOdds;
                    if (!odds || odds.statusMercado !== 'OPEN') return 0;
                    if (odds.oddCasaBack && odds.oddForaBack) {
                        const casaFav = odds.oddCasaBack < odds.oddForaBack;
                        if (casaFav && odds.oddCasaBack <= 2.2) return 1;
                    }
                    return 0;
                })();

                const w = QUANT_CONFIG.weights;
                const score = (w.acel * acelNorm) + (w.apm * apmNorm) + (w.qual * qualNorm) + (w.xgMoment * xgMomentNorm) + (w.market * marketSignal);
                const sustained = isSustainedPressure(jogo, "casa");

                analyzer.addExpected('GATILHO_2T', 'score', score.toFixed(2));
                if (!sustained) analyzer.addMissing('GATILHO_2T', 'sustainedPressure', `${(jogo._pressureWindowCasa||[]).join(',')}`);
                if (jogo.momentum.ataquesCasa < QUANT_CONFIG.ataqueThreshold2T) analyzer.addMissing('GATILHO_2T', 'ataquesCasa<12', jogo.momentum.ataquesCasa);
                if ((jogo.momentum.chutesNoAlvoCasa + jogo.momentum.escanteiosCasa) < QUANT_CONFIG.chEscThreshold2T) analyzer.addMissing('GATILHO_2T', 'ch+esc<3', (jogo.momentum.chutesNoAlvoCasa + jogo.momentum.escanteiosCasa));
                if (qualVal == null) analyzer.addMissing('GATILHO_2T', 'qualidadeN/D', 'N/D'); else if (qualVal < QUANT_CONFIG.qualThreshold2T) analyzer.addMissing('GATILHO_2T', 'qualidadeBaixa', Math.round((qualVal||0)*100));

                if (score >= QUANT_CONFIG.scoreThreshold &&
                    sustained &&
                    jogo.momentum.ataquesCasa >= QUANT_CONFIG.ataqueThreshold2T &&
                    (jogo.momentum.chutesNoAlvoCasa + jogo.momentum.escanteiosCasa) >= QUANT_CONFIG.chEscThreshold2T) {

                    alertas.golIminente2T = true;
                    analyzer.setMet('GATILHO_2T');
                    try { jogo._engineAnalysis.GATILHO_2T = jogo._engineAnalysis.GATILHO_2T || {}; jogo._engineAnalysis.GATILHO_2T.confidence = score; } catch (e) {}
                    const ctx = difGols < 0 ? '🔴 Casa a perder' : '🟡 Empate';
                    const msg = `🚨 *WOLF QUANT - GATILHO 2T*\n🏟️ ${jogo.nomePartida}\n⏱️ ${minAtual}' | ${ctx} | score:${score.toFixed(2)} | xG: ${jogo.xgCasa.toFixed(2)}-${jogo.xgFora.toFixed(2)}\n📊 APM Casa: ${apmCasa.toFixed(2)} | Aceleração: ${acCasa>0? '+'+acCasa:acCasa}\n🔬 AtqP: ${jogo.momentum.ataquesCasa} | Ch+Esc: ${jogo.momentum.chutesNoAlvoCasa + jogo.momentum.escanteiosCasa}`;
                    require('./logger').enviarAlertaTelegram(idJogo, jogo, msg, "GATILHO_2T");
                }
            }
        }

        // marca motivos pelos quais o gatilho ficou 'faltando' (mesma abordagem do 1T)
        if (emCooldown) analyzer.addMissing('GATILHO_2T', 'emCooldown', minAtual);
        if (minAtual < 46 || minAtual > 85) analyzer.addMissing('GATILHO_2T', 'janelaTempo', `${minAtual}'`);
        if (difGols > 0) analyzer.addMissing('GATILHO_2T', 'difGols>0', difGols);
        if (jogo.momentum.ataquesCasa < 12) analyzer.addMissing('GATILHO_2T', 'ataquesCasa<12', jogo.momentum.ataquesCasa);
        if ((jogo.momentum.chutesNoAlvoCasa + jogo.momentum.escanteiosCasa) < 3) analyzer.addMissing('GATILHO_2T', 'chutesNoAlvoCasa+escanteios<3', (jogo.momentum.chutesNoAlvoCasa + jogo.momentum.escanteiosCasa));
        if (acCasa < 0) analyzer.addMissing('GATILHO_2T', 'aceleracaoNegativa', acCasa);
        if (qualCasa < 0.18) analyzer.addMissing('GATILHO_2T', 'qualidadeBaixa - Qualidade do ataque ≥ 18%', (jogo.momentum.ataquesCasa>0? Math.round(qualCasa*100) : 'N/D'));
        if (!emCooldown && minAtual >= 46 && minAtual <= 85 && !alertas.golIminente2T && analyzer.get()['GATILHO_2T'].missing.length === 0) {
            alertas.golIminente2T = true;
            analyzer.setMet('GATILHO_2T');
            const ctx = difGols < 0 ? '🔴 Casa a perder' : '🟡 Empate';
            const msg = `🚨 *WOLF QUANT - GATILHO 2T*\n🏟️ ${jogo.nomePartida}\n⏱️ ${minAtual}' | ${ctx} | xG: ${jogo.xgCasa.toFixed(2)}-${jogo.xgFora.toFixed(2)}\n📊 APM Casa: ${apmCasa.toFixed(2)} | Aceleração: ${acCasa > 0 ? '+' : ''}${acCasa}\n🔬 AtqP: ${jogo.momentum.ataquesCasa} | Ch+Esc: ${jogo.momentum.chutesNoAlvoCasa + jogo.momentum.escanteiosCasa}`;
            require('./logger').enviarAlertaTelegram(idJogo, jogo, msg, "GATILHO_2T");
        }

        // ─────────────────────────────────────────────────────────────────
        // MÉTODO 3 — GATILHO 2T FORA: Equipa visitante pressiona no 2ºT
        // ✅ NOVO: Sistema era cego à equipa visitante — corrigido
        // Score: fora a perder ou empate
        // ─────────────────────────────────────────────────────────────────
        analyzer.init('GATILHO_2T_FORA');
        if (!emCooldown && minAtual >= 58 && minAtual <= 85 && !alertas.golIminente2TFora) {
            if (difGols >= 0) {
                const acelNorm = clamp01(calcularAceleracaoNormalizada(jogo.historicoAtqFora, minAtual));
                const apmNorm  = clamp01(apmFora / 1.5);
                const qualVal  = jogo.momentum.ataquesFora > 0 ? (jogo.momentum.chutesNoAlvoFora + jogo.momentum.escanteiosFora) / jogo.momentum.ataquesFora : null;
                const qualNorm = qualVal != null ? clamp01((qualVal - 0.05) / (0.4 - 0.05)) : 0;
                let xgMomentNorm = 0;
                try {
                    // use cached counts computed above to avoid filters
                    const chLast5 = (typeof chAlvoFora_last5 !== 'undefined') ? chAlvoFora_last5 : contarMaiorQueReverse(jogo.historicoChAlvoFora, Math.max(0, minAtual - 5));
                    const chPrev5 = (typeof chAlvoFora_prev5 !== 'undefined') ? chAlvoFora_prev5 : (contarMaiorQueReverse(jogo.historicoChAlvoFora, Math.max(0, minAtual - 10)) - chLast5);
                    const deltaCh = chLast5 - chPrev5;
                    xgMomentNorm = clamp01((deltaCh + 1) / 3);
                } catch (e) { xgMomentNorm = 0; }

                const marketSignal = (() => {
                    const odds = jogo.betfairOdds;
                    if (!odds || odds.statusMercado !== 'OPEN') return 0;
                    if (odds.oddCasaBack && odds.oddForaBack) {
                        const foraFav = odds.oddForaBack < odds.oddCasaBack;
                        if (foraFav && odds.oddForaBack <= 2.2) return 1;
                    }
                    return 0;
                })();

                const w = QUANT_CONFIG.weights;
                const score = (w.acel * acelNorm) + (w.apm * apmNorm) + (w.qual * qualNorm) + (w.xgMoment * xgMomentNorm) + (w.market * marketSignal);
                const sustained = isSustainedPressure(jogo, "fora");

                analyzer.addExpected('GATILHO_2T_FORA', 'score', score.toFixed(2));
                if (!sustained) analyzer.addMissing('GATILHO_2T_FORA', 'sustainedPressure', `${(jogo._pressureWindowFora||[]).join(',')}`);
                if (jogo.momentum.ataquesFora < QUANT_CONFIG.ataqueThreshold2T) analyzer.addMissing('GATILHO_2T_FORA', 'ataquesFora<12', jogo.momentum.ataquesFora);
                if ((jogo.momentum.chutesNoAlvoFora + jogo.momentum.escanteiosFora) < QUANT_CONFIG.chEscThreshold2T) analyzer.addMissing('GATILHO_2T_FORA', 'ch+esc<3', (jogo.momentum.chutesNoAlvoFora + jogo.momentum.escanteiosFora));
                if (qualVal == null) analyzer.addMissing('GATILHO_2T_FORA', 'qualidadeN/D', 'N/D'); else if (qualVal < QUANT_CONFIG.qualThreshold2T) analyzer.addMissing('GATILHO_2T_FORA', 'qualidadeBaixa', Math.round((qualVal||0)*100));

                if (score >= QUANT_CONFIG.scoreThreshold &&
                    sustained &&
                    jogo.momentum.ataquesFora >= QUANT_CONFIG.ataqueThreshold2T &&
                    (jogo.momentum.chutesNoAlvoFora + jogo.momentum.escanteiosFora) >= QUANT_CONFIG.chEscThreshold2T) {

                    alertas.golIminente2TFora = true;
                    analyzer.setMet('GATILHO_2T_FORA');
                    try { jogo._engineAnalysis.GATILHO_2T_FORA = jogo._engineAnalysis.GATILHO_2T_FORA || {}; jogo._engineAnalysis.GATILHO_2T_FORA.confidence = score; } catch (e) {}
                    const ctx = difGols > 0 ? '🔴 Fora a perder' : '🟡 Empate';
                    const msg = `🚨 *WOLF QUANT - GATILHO 2T FORA*\\n🏟️ ${jogo.nomePartida}\\n⏱️ ${minAtual}' | ${ctx} | score:${score.toFixed(2)} | xG: ${jogo.xgCasa.toFixed(2)}-${jogo.xgFora.toFixed(2)}\\n📊 APM Fora: ${apmFora.toFixed(2)} | Aceleração: ${acFora>0? '+'+acFora:acFora}\\n🔬 AtqP Fora: ${jogo.momentum.ataquesFora} | Ch+Esc: ${jogo.momentum.chutesNoAlvoFora + jogo.momentum.escanteiosFora}`;
                    require('./logger').enviarAlertaTelegram(idJogo, jogo, msg, "GATILHO_2T_FORA");
                }
            }
        }

        // marcar motivos de 'missing' para GATILHO_2T_FORA
        if (emCooldown) analyzer.addMissing('GATILHO_2T_FORA', 'emCooldown', minAtual);
        if (minAtual < 58 || minAtual > 85) analyzer.addMissing('GATILHO_2T_FORA', 'janelaTempo', `${minAtual}'`);
        if (difGols < 0) analyzer.addMissing('GATILHO_2T_FORA', 'difGols<0', difGols);
        if (jogo.momentum.ataquesFora < 12) analyzer.addMissing('GATILHO_2T_FORA', 'ataquesFora<12', jogo.momentum.ataquesFora);
        if ((jogo.momentum.chutesNoAlvoFora + jogo.momentum.escanteiosFora) < 3) analyzer.addMissing('GATILHO_2T_FORA', 'chutesNoAlvoFora+escanteios<3', (jogo.momentum.chutesNoAlvoFora + jogo.momentum.escanteiosFora));
        if (acFora < 0) analyzer.addMissing('GATILHO_2T_FORA', 'aceleracaoNegativa', acFora);
        if (qualFora < 0.18) analyzer.addMissing('GATILHO_2T_FORA', 'qualidadeBaixa - Qualidade do ataque ≥ 18%', (jogo.momentum.ataquesFora>0? Math.round(qualFora*100) : 'N/D'));
        if (!emCooldown && minAtual >= 58 && minAtual <= 85 && !alertas.golIminente2TFora && analyzer.get()['GATILHO_2T_FORA'].missing.length === 0) {
            alertas.golIminente2TFora = true;
            analyzer.setMet('GATILHO_2T_FORA');
            const ctx = difGols > 0 ? '🔴 Fora a perder' : '🟡 Empate';
            const msg = `🚨 *WOLF QUANT - GATILHO 2T FORA*\\n🏟️ ${jogo.nomePartida}\\n⏱️ ${minAtual}' | ${ctx} | xG: ${jogo.xgCasa.toFixed(2)}-${jogo.xgFora.toFixed(2)}\\n📊 APM Fora: ${apmFora.toFixed(2)} | Aceleração: ${acFora > 0 ? '+' : ''}${acFora}\\n🔬 AtqP Fora: ${jogo.momentum.ataquesFora} | Ch+Esc: ${jogo.momentum.chutesNoAlvoFora + jogo.momentum.escanteiosFora}`;
            require('./logger').enviarAlertaTelegram(idJogo, jogo, msg, "GATILHO_2T_FORA");
        }


        // ─────────────────────────────────────────────────────────────────
        // MÉTODO 6 — LAY THE DRAW (LTD): Lay no empate — mercado Match Odds
        // ✅ NOVO: A estratégia mais usada no trading profissional de futebol.
        // Quando o score está empatado e uma equipa domina claramente,
        // a probabilidade de o empate manter é muito baixa → Lay o draw.
        // Diferente de LAY 0x0/1x1 (correct score): este é no mercado 1x2.
        // Condição: dominância ≥ 2.0x + posse confirma + qualidade real
        // Janela: 25'–78' (antes disso a odd do draw é muito alta; depois cai)
        // ─────────────────────────────────────────────────────────────────
        analyzer.init('LAY_DRAW');
        analyzer.addExpected('LAY_DRAW', "janelaTempo - Janela 25'-80'", minAtual);
        if (minAtual < 25 || minAtual > 80) analyzer.addMissing('LAY_DRAW', "janelaTempo - Janela 25'-80'", `${minAtual}'`);
        analyzer.addExpected('LAY_DRAW', 'empate - Placar deve ser empate', jogo.placar || 'N/D');
        if (!(gC === gF)) analyzer.addMissing('LAY_DRAW', 'empate - Placar deve ser empate', jogo.placar || 'N/D');
        const ratioLayDraw = (apmCasa > 0 && apmFora > 0) ? Math.max(apmCasa, apmFora) / Math.min(apmCasa, apmFora) : 0;
        analyzer.addExpected('LAY_DRAW', 'dominancia<2.0 - Dominância ≥ 2.0x', ratioLayDraw);
        if (ratioLayDraw < 2.0) analyzer.addMissing('LAY_DRAW', 'dominancia<2.0 - Dominância ≥ 2.0x', ratioLayDraw);
        const apmDominanteLayDraw = apmCasa >= apmFora ? apmCasa : apmFora;
        analyzer.addExpected('LAY_DRAW', 'apmDominante<0.8 - APM da equipa dominante ≥ 0.8', apmDominanteLayDraw);
        if (apmDominanteLayDraw < 0.8) analyzer.addMissing('LAY_DRAW', 'apmDominante<0.8 - APM da equipa dominante ≥ 0.8', apmDominanteLayDraw);
        const atqDominanteLayDraw = apmCasa >= apmFora ? jogo.momentum.ataquesCasa : jogo.momentum.ataquesFora;
        analyzer.addExpected('LAY_DRAW', 'atqDominante<8 - Ataques da equipa dominante ≥ 8', atqDominanteLayDraw);
        if (atqDominanteLayDraw < 8) analyzer.addMissing('LAY_DRAW', 'atqDominante<8 - Ataques da equipa dominante ≥ 8', atqDominanteLayDraw);
        const qualDominanteLayDraw = apmCasa >= apmFora ? qualCasa : qualFora;
        // explicit criterion for quality of dominant team (expressed as percent)
        analyzer.addExpected('LAY_DRAW', 'qualDominante>=18% - Qualidade do ataque dominante ≥ 18%', Math.round(qualDominanteLayDraw*100));
        if (qualDominanteLayDraw < 0.18) analyzer.addMissing('LAY_DRAW', 'qualDominante>=18% - Qualidade do ataque dominante ≥ 18%', Math.round(qualDominanteLayDraw*100));
        // posse dominante (used later in composite check) - expose as criterion
        const posseDominanteLayDraw = apmCasa >= apmFora ? (jogo.posseBolaCasa || 50) : (jogo.posseBolaFora || 50);
        analyzer.addExpected('LAY_DRAW', 'posseConfirma - Posse confirmatória ≥ 55%', posseDominanteLayDraw);
        // if possession is the default 50 (no data), expose explicitly as N/D to the UI
        if (posseDominanteLayDraw === 50 && (jogo.posseBolaCasa == null && jogo.posseBolaFora == null)) {
            analyzer.addMissing('LAY_DRAW', 'posseConfirma - Posse confirmatória ≥ 55%', 'N/D');
        } else if (posseDominanteLayDraw < 55) {
            analyzer.addMissing('LAY_DRAW', 'posseConfirma - Posse confirmatória ≥ 55%', posseDominanteLayDraw);
        }
        if (!emCooldown && !alertas.layDraw && minAtual >= 25 && minAtual <= 78) {
            const ehEmpate = (gC === gF);
            if (ehEmpate) {
                const ratio = (apmCasa > 0 && apmFora > 0)
                    ? Math.max(apmCasa, apmFora) / Math.min(apmCasa, apmFora) : 0;
                const equipaDominante = apmCasa >= apmFora ? 'CASA' : 'FORA';
                const qualDominante   = apmCasa >= apmFora ? qualCasa : qualFora;
                const apmDominante    = apmCasa >= apmFora ? apmCasa : apmFora;
                const atqDominante    = apmCasa >= apmFora ? jogo.momentum.ataquesCasa : jogo.momentum.ataquesFora;
                const posseDominante  = apmCasa >= apmFora ? (jogo.posseBolaCasa || 50) : (jogo.posseBolaFora || 50);
                // Posse ≥ 55% é confirmatório mas não obrigatório (pode ser 50 se não scraped)
                const posseConfirma   = posseDominante >= 55 || posseDominante === 50; // 50 = default (sem dado)
                    if (ratio >= 2.0 && apmDominante >= 0.8 && atqDominante >= 8 &&
                    qualDominante >= 0.18 && posseConfirma) {
                    alertas.layDraw = true;
                        analyzer.setMet('LAY_DRAW');
                    const posseLabel = posseDominante !== 50 ? ` | Posse ${equipaDominante}: ${posseDominante}%` : '';
                    const msg = `🏆 *WOLF QUANT - LAY THE DRAW*\n🏟️ ${jogo.nomePartida}\n⏱️ ${minAtual}' | Score: ${jogo.placar} | xG: ${jogo.xgCasa.toFixed(2)}-${jogo.xgFora.toFixed(2)}\n📊 APM ${equipaDominante}: ${apmDominante.toFixed(2)} | Dominância: ${ratio.toFixed(1)}x${posseLabel}\n🔬 AtqP: ${atqDominante} | Qualidade: ${(qualDominante*100).toFixed(0)}%\n💡 Mercado: LAY DRAW (1x2) — ${equipaDominante} a dominar`;
                    require('./logger').enviarAlertaTelegram(idJogo, jogo, msg, "LAY_DRAW");
                }
            }
        }

        // ═════════════════════════════════════════════════════════════════
        // MÉTODOS COM INTEGRAÇÃO BETFAIR (requerem odds ao vivo)
        // ═════════════════════════════════════════════════════════════════
        const odds = jogo.betfairOdds;
        if (odds && odds.statusMercado === 'OPEN') {

            // ─────────────────────────────────────────────────────────────
            // MÉTODO 13 — FAVORITO VENCE: Back no favorito quando domina
            // O favorito em campo (odd ≤ 2.0) está a pressionar mais.
            // Mercado: Back no favorito (Match Odds 1x2)
            // Lógica: qualidade do mercado (odds) + qualidade do campo (APM)
            // Janela: 15'–70' (após 70' a odd cai demasiado para ter valor)
            // ─────────────────────────────────────────────────────────────
            analyzer.init('FAVORITO_VENCE');
            analyzer.addExpected('FAVORITO_VENCE', 'janelaTempo');
            if (minAtual < 15 || minAtual > 70) analyzer.addMissing('FAVORITO_VENCE', 'janelaTempo', `${minAtual}'`);
            if (!emCooldown && !alertas.favoritoVence && minAtual >= 15 && minAtual <= 70) {
                const ehEmpate = (gC === gF);
                if (ehEmpate && odds.oddCasaBack && odds.oddForaBack) {
                    // Identifica qual é o favorito pelo mercado
                    const casaEFavorita = odds.oddCasaBack < odds.oddForaBack && odds.oddCasaBack <= 2.2;
                    const foraEFavorita = odds.oddForaBack < odds.oddCasaBack && odds.oddForaBack <= 2.2;
                    const favoritoTenAPM = casaEFavorita
                        ? (apmCasa >= apmFora * 1.5 && jogo.momentum.ataquesCasa >= 8 && qualCasa >= 0.18)
                        : foraEFavorita
                        ? (apmFora >= apmCasa * 1.5 && jogo.momentum.ataquesFora >= 8 && qualFora >= 0.18)
                        : false;

                    if (favoritoTenAPM) {
                        alertas.favoritoVence = true;
                        analyzer.setMet('FAVORITO_VENCE');
                        const equipa     = casaEFavorita ? 'CASA' : 'FORA';
                        const oddFav     = casaEFavorita ? odds.oddCasaBack : odds.oddForaBack;
                        const apmFav     = casaEFavorita ? apmCasa : apmFora;
                        const atqFav     = casaEFavorita ? jogo.momentum.ataquesCasa : jogo.momentum.ataquesFora;
                        const msg = `💰 *WOLF QUANT - FAVORITO VENCE*\n🏟️ ${jogo.nomePartida}\n⏱️ ${minAtual}' | Score: ${jogo.placar} | xG: ${jogo.xgCasa.toFixed(2)}-${jogo.xgFora.toFixed(2)}\n📈 Odd ${equipa}: ${oddFav} | APM ${equipa}: ${apmFav.toFixed(2)}\n🔬 AtqP Dominante (10m): ${atqFav}\n💡 Mercado: BACK ${equipa} (Match Odds) — favorito a dominar`;
                        require('./logger').enviarAlertaTelegram(idJogo, jogo, msg, "FAVORITO_VENCE");
                    }
                }
            }

            // ─────────────────────────────────────────────────────────────
            // MÉTODO 14 — FAVORITO VIRA: Favorito está a perder mas pressiona
            // O mercado ainda acredita no favorito (odd ≤ 2.8 mesmo a perder).
            // Mercado: Back no favorito OU Lay no azarão que lidera
            // Janela: 20'–75'
            // ─────────────────────────────────────────────────────────────
            analyzer.init('FAVORITO_VIRA');
            analyzer.addExpected('FAVORITO_VIRA', 'janelaTempo');
            if (minAtual < 20 || minAtual > 75) analyzer.addMissing('FAVORITO_VIRA', 'janelaTempo', `${minAtual}'`);
            if (!emCooldown && !alertas.favoritoVira && minAtual >= 20 && minAtual <= 75) {
                if (odds.oddCasaBack && odds.oddForaBack) {
                    // Casa é favorita mas está a perder (score 0-1 ou 1-2)
                    const casaFavoritaPerdendo = (odds.oddCasaBack < odds.oddForaBack) &&
                        odds.oddCasaBack <= 2.8 && difGols < 0 &&
                        apmCasa >= 0.8 && jogo.momentum.ataquesCasa >= 8 &&
                        qualCasa >= 0.20 && acCasa > 0 &&
                        jogo.xgCasa >= jogo.xgFora * 0.40;

                    // Fora é favorita mas está a perder (score 1-0 ou 2-1)
                    const foraFavoritaPerdendo = (odds.oddForaBack < odds.oddCasaBack) &&
                        odds.oddForaBack <= 2.8 && difGols > 0 &&
                        apmFora >= 0.8 && jogo.momentum.ataquesFora >= 8 &&
                        qualFora >= 0.20 && acFora > 0 &&
                        jogo.xgFora >= jogo.xgCasa * 0.40;

                    if (casaFavoritaPerdendo || foraFavoritaPerdendo) {
                        alertas.favoritoVira = true;
                        analyzer.setMet('FAVORITO_VIRA');
                        const equipa     = casaFavoritaPerdendo ? 'CASA' : 'FORA';
                        const oddFav     = casaFavoritaPerdendo ? odds.oddCasaBack : odds.oddForaBack;
                        const oddAzarao  = casaFavoritaPerdendo ? odds.oddForaLay  : odds.oddCasaLay;
                        const apmFav     = casaFavoritaPerdendo ? apmCasa : apmFora;
                        const atqFav     = casaFavoritaPerdendo ? jogo.momentum.ataquesCasa : jogo.momentum.ataquesFora;
                        const qualFav    = casaFavoritaPerdendo ? qualCasa : qualFora;
                        const msg = `🔄 *WOLF QUANT - FAVORITO VIRA*\n🏟️ ${jogo.nomePartida}\n⏱️ ${minAtual}' | Score: ${jogo.placar} | xG: ${jogo.xgCasa.toFixed(2)}-${jogo.xgFora.toFixed(2)}\n📈 Odd ${equipa}: ${oddFav} | Lay Azarão: ${oddAzarao || 'N/D'}\n🔬 APM ${equipa}: ${apmFav.toFixed(2)} | AtqP: ${atqFav} | Qualidade: ${(qualFav*100).toFixed(0)}%\n💡 Favorito a pressionar — BACK ${equipa} ou LAY no adversário`;
                        require('./logger').enviarAlertaTelegram(idJogo, jogo, msg, "FAVORITO_VIRA");
                    }
                    else {
                        // mark missing reasons when favoritoVira conditions not met
                        if (!(odds.oddCasaBack && odds.oddForaBack)) analyzer.addMissing('FAVORITO_VIRA', 'oddsN/D');
                        if (!casaFavoritaPerdendo && !foraFavoritaPerdendo) analyzer.addMissing('FAVORITO_VIRA', 'favoritoNaoPerdendo');
                    }
                }
            }
        }
    }
    // attach analyzer snapshot to jogo for external consumption (logger / UI)
    try {
        const snap = analyzer.get && typeof analyzer.get === 'function' ? analyzer.get() : null;
        // ensure we never set null — keep previous value or set empty object
        if (snap && Object.keys(snap).length > 0) {
            jogo._engineAnalysis = snap;
        } else {
            // preserve existing _engineAnalysis if present, otherwise set to empty object
            jogo._engineAnalysis = jogo._engineAnalysis && Object.keys(jogo._engineAnalysis || {}).length > 0
                ? jogo._engineAnalysis
                : {};
        }
        // lightweight debug to help detect why UI sees nulls
        try { console.debug && console.debug('[ENGINE] attached _engineAnalysis for', jogo.id, 'methods=', Object.keys(jogo._engineAnalysis || {}).length); } catch (e) {}
    } catch (e) { /* non-fatal - keep existing state */ }

}

module.exports = { processarMotorDeRegras };
