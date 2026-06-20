// engine_quant.js

/**
 * Motor Matemático e Computacional Lobo Quant v2.1 — Nível Profissional
 */

function calcularPressaoAPM(
    historico, tempoAtual) {
    if (tempoAtual <= 0) return 0;
    const limite = Math.max(0, tempoAtual - 5);
    return historico.filter(m => m > limite).length / 5;
}

function calcularMomentumMicro10(historico, tempoAtual) {
    if (tempoAtual <= 0) return 0;
    const limite = Math.max(0, tempoAtual - 10);
    return historico.filter(m => m > limite).length;
}

/**
 * Aceleração de momentum: últimos 5m vs 5m anteriores.
 * > 0 = pressão crescente | < 0 = pressão a cair | = 0 = estável
 */
function calcularAceleracao(historico, tempoAtual) {
    if (tempoAtual < 5) return 0;
    const l5  = Math.max(0, tempoAtual - 5);
    const l10 = Math.max(0, tempoAtual - 10);
    return historico.filter(m => m > l5).length -
           historico.filter(m => m > l10 && m <= l5).length;
}

/** Parse seguro do placar "G-G" → { gC, gF } */
function parsePlacar(placar) {
    const p = (placar || '0-0').split('-').map(Number);
    return { gC: p[0] || 0, gF: p[1] || 0 };
}

const { createAnalyzer } = require('./engine_analysis');

function processarMotorDeRegras(idJogo, jogo, alertas) {
    const minAtual = jogo.tempo;
    // objecto de análise por método (visível no front-end via logger)
    const analyzer = createAnalyzer();
    // Anexa a referência do objeto de análise ao jogo desde já (é o mesmo objeto mutável)
    try { jogo._engineAnalysis = analyzer.get(); } catch (e) { /* non-fatal */ }
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
        // NOTE: broadened 2T window to start at 46' so second-half early minutes are considered
        if (!emCooldown && minAtual >= 46 && minAtual <= 85 && !alertas.golIminente2T) {
            // compute booleans for debug/traceability
            const okWindow = (minAtual >= 46 && minAtual <= 85);
            const okDif = difGols <= 0;
            const okAtaques = jogo.momentum.ataquesCasa >= 12;
            const okChEsc = (jogo.momentum.chutesNoAlvoCasa + jogo.momentum.escanteiosCasa) >= 3;
            const okAcel = acCasa >= 0;
            const okQual = qualCasa >= 0.18;
            // (removed verbose debug logging)
            if (okDif && okAtaques && okChEsc && okAcel && okQual) {
                alertas.golIminente2T = true;
                analyzer.setMet('GATILHO_2T');
                const ctx = difGols < 0 ? '🔴 Casa a perder' : '🟡 Empate';
                const msg = `🚨 *WOLF QUANT - GATILHO 2T*\n🏟️ ${jogo.nomePartida}\n⏱️ ${minAtual}' | ${ctx} | xG: ${jogo.xgCasa.toFixed(2)}-${jogo.xgFora.toFixed(2)}\n📊 APM Casa: ${apmCasa.toFixed(2)} | Aceleração: ${acCasa > 0 ? '+' : ''}${acCasa}\n🔬 AtqP: ${jogo.momentum.ataquesCasa} | Ch+Esc: ${jogo.momentum.chutesNoAlvoCasa + jogo.momentum.escanteiosCasa}`;
                require('./logger').enviarAlertaTelegram(idJogo, jogo, msg, "GATILHO_2T");
            }
        }
        // marca motivos pelos quais o gatilho ficou 'faltando' (mesma abordagem do 1T)
        if (emCooldown) analyzer.addMissing('GATILHO_2T', 'emCooldown', minAtual);
        if (minAtual < 46 || minAtual > 85) analyzer.addMissing('GATILHO_2T', 'janelaTempo', `${minAtual}'`);
        if (difGols > 0) analyzer.addMissing('GATILHO_2T', 'difGols>0', difGols);
        if (jogo.momentum.ataquesCasa < 12) analyzer.addMissing('GATILHO_2T', 'ataquesCasa<12', jogo.momentum.ataquesCasa);
        if ((jogo.momentum.chutesNoAlvoCasa + jogo.momentum.escanteiosCasa) < 3) analyzer.addMissing('GATILHO_2T', 'chutesNoAlvoCasa+escanteios<3', (jogo.momentum.chutesNoAlvoCasa + jogo.momentum.escanteiosCasa));
        if (acCasa < 0) analyzer.addMissing('GATILHO_2T', 'aceleracaoNegativa', acCasa);
        if (qualCasa < 0.18) analyzer.addMissing('GATILHO_2T', 'qualidadeBaixa - Qualidade do ataque ≥ 18%', Math.round(qualCasa*100));
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
            if (difGols >= 0 &&   // fora a perder (difGols>0) ou empate (=0)
                jogo.momentum.ataquesFora >= 12 &&
                (jogo.momentum.chutesNoAlvoFora + jogo.momentum.escanteiosFora) >= 3 &&
                acFora >= 0 && qualFora >= 0.18) {
                alertas.golIminente2TFora = true;
                analyzer.setMet('GATILHO_2T_FORA');
                const ctx = difGols > 0 ? '🔴 Fora a perder' : '🟡 Empate';
                const msg = `🚨 *WOLF QUANT - GATILHO 2T FORA*\n🏟️ ${jogo.nomePartida}\n⏱️ ${minAtual}' | ${ctx} | xG: ${jogo.xgCasa.toFixed(2)}-${jogo.xgFora.toFixed(2)}\n📊 APM Fora: ${apmFora.toFixed(2)} | Aceleração: ${acFora > 0 ? '+' : ''}${acFora}\n🔬 AtqP Fora: ${jogo.momentum.ataquesFora} | Ch+Esc: ${jogo.momentum.chutesNoAlvoFora + jogo.momentum.escanteiosFora}`;
                require('./logger').enviarAlertaTelegram(idJogo, jogo, msg, "GATILHO_2T_FORA");
            }
        }
        // marcar motivos de 'missing' para GATILHO_2T_FORA
        if (emCooldown) analyzer.addMissing('GATILHO_2T_FORA', 'emCooldown', minAtual);
        if (minAtual < 58 || minAtual > 85) analyzer.addMissing('GATILHO_2T_FORA', 'janelaTempo', `${minAtual}'`);
        if (difGols < 0) analyzer.addMissing('GATILHO_2T_FORA', 'difGols<0', difGols);
        if (jogo.momentum.ataquesFora < 12) analyzer.addMissing('GATILHO_2T_FORA', 'ataquesFora<12', jogo.momentum.ataquesFora);
        if ((jogo.momentum.chutesNoAlvoFora + jogo.momentum.escanteiosFora) < 3) analyzer.addMissing('GATILHO_2T_FORA', 'chutesNoAlvoFora+escanteios<3', (jogo.momentum.chutesNoAlvoFora + jogo.momentum.escanteiosFora));
        if (acFora < 0) analyzer.addMissing('GATILHO_2T_FORA', 'aceleracaoNegativa', acFora);
        if (qualFora < 0.18) analyzer.addMissing('GATILHO_2T_FORA', 'qualidadeBaixa - Qualidade do ataque ≥ 18%', Math.round(qualFora*100));
        if (!emCooldown && minAtual >= 58 && minAtual <= 85 && !alertas.golIminente2TFora && analyzer.get()['GATILHO_2T_FORA'].missing.length === 0) {
            alertas.golIminente2TFora = true;
            analyzer.setMet('GATILHO_2T_FORA');
            const ctx = difGols > 0 ? '🔴 Fora a perder' : '🟡 Empate';
            const msg = `🚨 *WOLF QUANT - GATILHO 2T FORA*\n🏟️ ${jogo.nomePartida}\n⏱️ ${minAtual}' | ${ctx} | xG: ${jogo.xgCasa.toFixed(2)}-${jogo.xgFora.toFixed(2)}\n📊 APM Fora: ${apmFora.toFixed(2)} | Aceleração: ${acFora > 0 ? '+' : ''}${acFora}\n🔬 AtqP Fora: ${jogo.momentum.ataquesFora} | Ch+Esc: ${jogo.momentum.chutesNoAlvoFora + jogo.momentum.escanteiosFora}`;
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


        // ─────────────────────────────────────────────────────────────────
        // MÉTODO 7 — LAY 0x1: Casa perde 0-1 e pressiona (20'–82')
        // ✅ Aceleração ESTRITAMENTE > 0 (crescimento real, não estável)
        // ✅ Gate xG competitivo: casa deve ter criado ≥ 40% do xG da fora
        //    (evita entrar quando a fora merecia ganhar por muito mais)
        // ─────────────────────────────────────────────────────────────────
        analyzer.init('LAY_0x1');
        analyzer.addExpected('LAY_0x1', "janelaTempo - Janela 20'-82'", minAtual);
        if (minAtual < 20 || minAtual > 82) analyzer.addMissing('LAY_0x1', "janelaTempo - Janela 20'-82'", `${minAtual}'`);
        analyzer.addExpected('LAY_0x1', 'placar!=0-1 - Placar atual deve ser 0-1', jogo.placar || 'N/D');
        if (!(gC === 0 && gF === 1)) analyzer.addMissing('LAY_0x1', 'placar!=0-1 - Placar atual deve ser 0-1', jogo.placar || 'N/D');
        const xgCompetitivo0x1 = jogo.xgFora > 0 ? jogo.xgCasa >= jogo.xgFora * 0.40 : jogo.xgCasa >= 0.08;
        analyzer.addExpected('LAY_0x1', 'apmCasa<0.6 - APM Casa ≥ 0.6', apmCasa);
        if (apmCasa < 0.6) analyzer.addMissing('LAY_0x1', 'apmCasa<0.6 - APM Casa ≥ 0.6', apmCasa);
        analyzer.addExpected('LAY_0x1', 'ataquesCasa<6 - Ataques Casa ≥ 6', jogo.momentum.ataquesCasa);
        if (jogo.momentum.ataquesCasa < 6) analyzer.addMissing('LAY_0x1', 'ataquesCasa<6 - Ataques Casa ≥ 6', jogo.momentum.ataquesCasa);
        const chutesEscCasa = jogo.momentum.chutesNoAlvoCasa + jogo.momentum.escanteiosCasa;
        analyzer.addExpected('LAY_0x1', 'chutes+esc<2 - Chutes+Esc ≥ 2', chutesEscCasa);
        if (chutesEscCasa < 2) analyzer.addMissing('LAY_0x1', 'chutes+esc<2 - Chutes+Esc ≥ 2', chutesEscCasa);
        analyzer.addExpected('LAY_0x1', 'qualidadeBaixa - Qualidade do ataque ≥ 20%', Math.round(qualCasa*100));
        if (qualCasa < 0.20) analyzer.addMissing('LAY_0x1', 'qualidadeBaixa - Qualidade do ataque ≥ 20%', Math.round(qualCasa*100));
        analyzer.addExpected('LAY_0x1', 'aceleracaoNegativa - Aceleração > 0 (crescimento)', acCasa);
        if (acCasa <= 0) analyzer.addMissing('LAY_0x1', 'aceleracaoNegativa - Aceleração > 0 (crescimento)', acCasa);
        analyzer.addExpected('LAY_0x1', 'xgIncompativel - xG compatível com pressão', (jogo.xgCasa || 0).toFixed(2));
        if (!xgCompetitivo0x1) analyzer.addMissing('LAY_0x1', 'xgIncompativel - xG compatível com pressão', (jogo.xgCasa || 0).toFixed(2));
        if (!emCooldown && !alertas.lay01 && minAtual >= 20 && minAtual <= 82) {
            if (gC === 0 && gF === 1) {
                const xgCompetitivo = jogo.xgFora > 0
                    ? jogo.xgCasa >= jogo.xgFora * 0.40
                    : jogo.xgCasa >= 0.08;
                const posseCasa = jogo.posseBolaCasa || 50;
                    if (apmCasa >= 0.6 && jogo.momentum.ataquesCasa >= 6 &&
                    (jogo.momentum.chutesNoAlvoCasa + jogo.momentum.escanteiosCasa) >= 2 &&
                    qualCasa >= 0.20 && acCasa > 0 && xgCompetitivo) {
                    alertas.lay01 = true;
                        analyzer.setMet('LAY_0x1');
                    const msg = `⚡ *WOLF QUANT - LAY 0x1*\n🏟️ ${jogo.nomePartida}\n⏱️ ${minAtual}' | xG: ${jogo.xgCasa.toFixed(2)}-${jogo.xgFora.toFixed(2)}\n📊 APM Casa: ${apmCasa.toFixed(2)} | Aceleração: +${acCasa}\n🔬 AtqP: ${jogo.momentum.ataquesCasa} | Ch+Esc: ${jogo.momentum.chutesNoAlvoCasa + jogo.momentum.escanteiosCasa} | Qualidade: ${(qualCasa*100).toFixed(0)}%\n💡 Casa a pressionar — back no empate`;
                    require('./logger').enviarAlertaTelegram(idJogo, jogo, msg, "LAY_0x1");
                }
            }
        }

        // ─────────────────────────────────────────────────────────────────
        // MÉTODO 8 — LAY 1x0: Fora perde 1-0 e pressiona (20'–82')
        // ✅ Mirror profissional do LAY 0x1 com gate xG competitivo
        // ─────────────────────────────────────────────────────────────────
        analyzer.init('LAY_1x0');
        analyzer.addExpected('LAY_1x0', "janelaTempo - Janela 20'-82'", minAtual);
        if (minAtual < 20 || minAtual > 82) analyzer.addMissing('LAY_1x0', "janelaTempo - Janela 20'-82'", `${minAtual}'`);
        analyzer.addExpected('LAY_1x0', `placar!=1-0 - Placar atual deve ser 1-0`, jogo.placar || 'N/D');
        if (!(gC === 1 && gF === 0)) analyzer.addMissing('LAY_1x0', `placar!=1-0 - Placar atual deve ser 1-0`, jogo.placar || 'N/D');
        const xgCompetitivo1x0 = jogo.xgCasa > 0 ? jogo.xgFora >= jogo.xgCasa * 0.40 : jogo.xgFora >= 0.08;
        analyzer.addExpected('LAY_1x0', 'apmFora<0.6 - APM Fora >= 0.6', apmFora);
        if (apmFora < 0.6) analyzer.addMissing('LAY_1x0', 'apmFora<0.6 - APM Fora >= 0.6', apmFora);
        analyzer.addExpected('LAY_1x0', 'ataquesFora<6 - Ataques Fora >= 6', jogo.momentum.ataquesFora);
        if (jogo.momentum.ataquesFora < 6) analyzer.addMissing('LAY_1x0', 'ataquesFora<6 - Ataques Fora >= 6', jogo.momentum.ataquesFora);
        const chutesEscFora = jogo.momentum.chutesNoAlvoFora + jogo.momentum.escanteiosFora;
        analyzer.addExpected('LAY_1x0', 'chutes+esc<2 - Chutes+Esc >= 2', chutesEscFora);
        if (chutesEscFora < 2) analyzer.addMissing('LAY_1x0', 'chutes+esc<2 - Chutes+Esc >= 2', chutesEscFora);
        analyzer.addExpected('LAY_1x0', 'qualidadeBaixa - Qualidade do ataque >= 0.20', Math.round(qualFora*100));
        if (qualFora < 0.20) analyzer.addMissing('LAY_1x0', 'qualidadeBaixa - Qualidade do ataque >= 0.20', Math.round(qualFora*100));
        analyzer.addExpected('LAY_1x0', 'aceleracaoNegativa - Aceleração > 0 (crescimento)', acFora);
        if (acFora <= 0) analyzer.addMissing('LAY_1x0', 'aceleracaoNegativa - Aceleração > 0 (crescimento)', acFora);
        analyzer.addExpected('LAY_1x0', 'xgIncompativel - xG compatível com pressão', (jogo.xgFora || 0).toFixed(2));
        if (!xgCompetitivo1x0) analyzer.addMissing('LAY_1x0', 'xgIncompativel - xG compatível com pressão', (jogo.xgFora || 0).toFixed(2));
        if (!emCooldown && !alertas.lay10 && minAtual >= 20 && minAtual <= 82) {
            if (gC === 1 && gF === 0) {
                const xgCompetitivo = jogo.xgCasa > 0
                    ? jogo.xgFora >= jogo.xgCasa * 0.40
                    : jogo.xgFora >= 0.08;
                const posseCasa = jogo.posseBolaCasa || 50;
                    if (apmFora >= 0.6 && jogo.momentum.ataquesFora >= 6 &&
                    (jogo.momentum.chutesNoAlvoFora + jogo.momentum.escanteiosFora) >= 2 &&
                    qualFora >= 0.20 && acFora > 0 && xgCompetitivo) {
                    alertas.lay10 = true;
                        analyzer.setMet('LAY_1x0');
                    const posseLabel = posseCasa !== 50 ? ` | Posse Casa: ${posseCasa}%` : '';
                    const msg = `⚡ *WOLF QUANT - LAY 1x0*\n🏟️ ${jogo.nomePartida}\n⏱️ ${minAtual}' | xG: ${jogo.xgCasa.toFixed(2)}-${jogo.xgFora.toFixed(2)}\n📊 APM Fora: ${apmFora.toFixed(2)} | Aceleração: +${acFora}\n🔬 AtqP: ${jogo.momentum.ataquesFora} | Ch+Esc: ${jogo.momentum.chutesNoAlvoFora + jogo.momentum.escanteiosFora} | Qualidade: ${(qualFora*100).toFixed(0)}%\n💡 Fora a pressionar — back no empate`;
                    require('./logger').enviarAlertaTelegram(idJogo, jogo, msg, "LAY_1x0");
                }
            }
        }

        // ─────────────────────────────────────────────────────────────────
        // MÉTODO 10 — LAY 1x2: Casa perde 1-2 e pressiona forte (20'–72')
        // ✅ NOVO: Variante avançada do LAY 0x1 para deficit de 1 em 2 golos.
        // Thresholds mais exigentes porque recuperar de 1-2 é mais difícil.
        // Casa precisa de 1 golo para empatar — lay na vitória da fora.
        // ─────────────────────────────────────────────────────────────────
        analyzer.init('LAY_1x2');
        analyzer.addExpected('LAY_1x2', "janelaTempo - Janela 20'-72'", minAtual);
        if (minAtual < 20 || minAtual > 72) analyzer.addMissing('LAY_1x2', "janelaTempo - Janela 20'-72'", `${minAtual}'`);
        analyzer.addExpected('LAY_1x2', 'placar!=1-2 - Placar atual deve ser 1-2', jogo.placar || 'N/D');
        if (!(gC === 1 && gF === 2)) analyzer.addMissing('LAY_1x2', 'placar!=1-2 - Placar atual deve ser 1-2', jogo.placar || 'N/D');
        const xgCompetitivo1x2 = jogo.xgFora > 0 ? jogo.xgCasa >= jogo.xgFora * 0.35 : jogo.xgCasa >= 0.12;
        analyzer.addExpected('LAY_1x2', 'apmCasa<0.8 - APM Casa ≥ 0.8', apmCasa);
        if (apmCasa < 0.8) analyzer.addMissing('LAY_1x2', 'apmCasa<0.8 - APM Casa ≥ 0.8', apmCasa);
        analyzer.addExpected('LAY_1x2', 'ataquesCasa<8 - Ataques Casa ≥ 8', jogo.momentum.ataquesCasa);
        if (jogo.momentum.ataquesCasa < 8) analyzer.addMissing('LAY_1x2', 'ataquesCasa<8 - Ataques Casa ≥ 8', jogo.momentum.ataquesCasa);
        const chutesEscCasa1x2 = jogo.momentum.chutesNoAlvoCasa + jogo.momentum.escanteiosCasa;
        analyzer.addExpected('LAY_1x2', 'chutes+esc<3 - Chutes+Esc ≥ 3', chutesEscCasa1x2);
        if (chutesEscCasa1x2 < 3) analyzer.addMissing('LAY_1x2', 'chutes+esc<3 - Chutes+Esc ≥ 3', chutesEscCasa1x2);
        analyzer.addExpected('LAY_1x2', 'qualidadeBaixa - Qualidade do ataque ≥ 22%', Math.round(qualCasa*100));
        if (qualCasa < 0.22) analyzer.addMissing('LAY_1x2', 'qualidadeBaixa - Qualidade do ataque ≥ 22%', Math.round(qualCasa*100));
        analyzer.addExpected('LAY_1x2', 'aceleracaoNegativa - Aceleração > 0 (crescimento)', acCasa);
        if (acCasa <= 0) analyzer.addMissing('LAY_1x2', 'aceleracaoNegativa - Aceleração > 0 (crescimento)', acCasa);
        analyzer.addExpected('LAY_1x2', 'xgIncompativel - xG compatível com pressão', (jogo.xgCasa || 0).toFixed(2));
        if (!xgCompetitivo1x2) analyzer.addMissing('LAY_1x2', 'xgIncompativel - xG compatível com pressão', (jogo.xgCasa || 0).toFixed(2));
        if (!emCooldown && !alertas.lay12 && minAtual >= 20 && minAtual <= 72) {
            if (gC === 1 && gF === 2) {
                const xgCompetitivo = jogo.xgFora > 0
                    ? jogo.xgCasa >= jogo.xgFora * 0.35
                    : jogo.xgCasa >= 0.12;
                const posseCasa = jogo.posseBolaCasa || 50;
                    if (apmCasa >= 0.8 && jogo.momentum.ataquesCasa >= 8 &&
                    (jogo.momentum.chutesNoAlvoCasa + jogo.momentum.escanteiosCasa) >= 3 &&
                    qualCasa >= 0.22 && acCasa > 0 && xgCompetitivo) {
                    alertas.lay12 = true;
                        analyzer.setMet('LAY_1x2');
                    const posseLabel = posseCasa !== 50 ? ` | Posse Casa: ${posseCasa}%` : '';
                    const msg = `⚡ *WOLF QUANT - LAY 1x2*\n🏟️ ${jogo.nomePartida}\n⏱️ ${minAtual}' | 🔴 Casa a perder 1-2${posseLabel}\n📊 APM Casa: ${apmCasa.toFixed(2)} | Aceleração: +${acCasa} | xG: ${jogo.xgCasa.toFixed(2)}-${jogo.xgFora.toFixed(2)}\n🔬 AtqP: ${jogo.momentum.ataquesCasa} | Ch+Esc: ${jogo.momentum.chutesNoAlvoCasa + jogo.momentum.escanteiosCasa} | Qualidade: ${(qualCasa*100).toFixed(0)}%\n⚠️ Risco elevado — precisa de 1 golo para empatar`;
                    require('./logger').enviarAlertaTelegram(idJogo, jogo, msg, "LAY_1x2");
                }
            }
        }

        // ─────────────────────────────────────────────────────────────────
        // MÉTODO 11 — LAY 2x1: Fora perde 2-1 e pressiona forte (20'–72')
        // ✅ NOVO: Mirror do LAY 1x2 para a equipa visitante.
        // ─────────────────────────────────────────────────────────────────
        analyzer.init('LAY_2x1');
        analyzer.addExpected('LAY_2x1', "janelaTempo - Janela 20'-72'", minAtual);
        if (minAtual < 20 || minAtual > 72) analyzer.addMissing('LAY_2x1', "janelaTempo - Janela 20'-72'", `${minAtual}'`);
        analyzer.addExpected('LAY_2x1', 'placar!=2-1 - Placar atual deve ser 2-1', jogo.placar || 'N/D');
        if (!(gC === 2 && gF === 1)) analyzer.addMissing('LAY_2x1', 'placar!=2-1 - Placar atual deve ser 2-1', jogo.placar || 'N/D');
        const xgCompetitivo2x1 = jogo.xgCasa > 0 ? jogo.xgFora >= jogo.xgCasa * 0.35 : jogo.xgFora >= 0.12;
        analyzer.addExpected('LAY_2x1', 'apmFora<0.8 - APM Fora ≥ 0.8', apmFora);
        if (apmFora < 0.8) analyzer.addMissing('LAY_2x1', 'apmFora<0.8 - APM Fora ≥ 0.8', apmFora);
        analyzer.addExpected('LAY_2x1', 'ataquesFora<8 - Ataques Fora ≥ 8', jogo.momentum.ataquesFora);
        if (jogo.momentum.ataquesFora < 8) analyzer.addMissing('LAY_2x1', 'ataquesFora<8 - Ataques Fora ≥ 8', jogo.momentum.ataquesFora);
        const chutesEscFora21 = jogo.momentum.chutesNoAlvoFora + jogo.momentum.escanteiosFora;
        analyzer.addExpected('LAY_2x1', 'chutes+esc<3 - Chutes+Esc ≥ 3', chutesEscFora21);
        if (chutesEscFora21 < 3) analyzer.addMissing('LAY_2x1', 'chutes+esc<3 - Chutes+Esc ≥ 3', chutesEscFora21);
        analyzer.addExpected('LAY_2x1', 'qualidadeBaixa - Qualidade do ataque ≥ 22%', Math.round(qualFora*100));
        if (qualFora < 0.22) analyzer.addMissing('LAY_2x1', 'qualidadeBaixa - Qualidade do ataque ≥ 22%', Math.round(qualFora*100));
        analyzer.addExpected('LAY_2x1', 'aceleracaoNegativa - Aceleração > 0 (crescimento)', acFora);
        if (acFora <= 0) analyzer.addMissing('LAY_2x1', 'aceleracaoNegativa - Aceleração > 0 (crescimento)', acFora);
        analyzer.addExpected('LAY_2x1', 'xgIncompativel - xG compatível com pressão', (jogo.xgFora || 0).toFixed(2));
        if (!xgCompetitivo2x1) analyzer.addMissing('LAY_2x1', 'xgIncompativel - xG compatível com pressão', (jogo.xgFora || 0).toFixed(2));
        if (!emCooldown && !alertas.lay21 && minAtual >= 20 && minAtual <= 72) {
            if (gC === 2 && gF === 1) {
                const xgCompetitivo = jogo.xgCasa > 0
                    ? jogo.xgFora >= jogo.xgCasa * 0.35
                    : jogo.xgFora >= 0.12;
                const posseFora = jogo.posseBolaFora || 50;
                    if (apmFora >= 0.8 && jogo.momentum.ataquesFora >= 8 &&
                    (jogo.momentum.chutesNoAlvoFora + jogo.momentum.escanteiosFora) >= 3 &&
                    qualFora >= 0.22 && acFora > 0 && xgCompetitivo) {
                    alertas.lay21 = true;
                        analyzer.setMet('LAY_2x1');
                    const posseLabel = posseFora !== 50 ? ` | Posse Fora: ${posseFora}%` : '';
                    const msg = `⚡ *WOLF QUANT - LAY 2x1*\n🏟️ ${jogo.nomePartida}\n⏱️ ${minAtual}' | 🔴 Fora a perder 2-1${posseLabel}\n📊 APM Fora: ${apmFora.toFixed(2)} | Aceleração: +${acFora} | xG: ${jogo.xgCasa.toFixed(2)}-${jogo.xgFora.toFixed(2)}\n🔬 AtqP: ${jogo.momentum.ataquesFora} | Ch+Esc: ${jogo.momentum.chutesNoAlvoFora + jogo.momentum.escanteiosFora} | Qualidade: ${(qualFora*100).toFixed(0)}%\n⚠️ Risco elevado — precisa de 1 golo para empatar`;
                    require('./logger').enviarAlertaTelegram(idJogo, jogo, msg, "LAY_2x1");
                }
            }
        }

        // ─────────────────────────────────────────────────────────────────
        // MÉTODO 12 — LAY 1x1: Empate 1-1 com dominância direcional (30'–78')
        // ✅ Ratio dominância ≥ 1.8x (era 1.5 — muito fácil de atingir)
        // ✅ A equipa dominante deve ter qualidade ≥ 0.20 (não só volume)
        // ─────────────────────────────────────────────────────────────────
        analyzer.init('LAY_1x1');
        analyzer.addExpected('LAY_1x1', "janelaTempo - Janela 30'-78'", minAtual);
        if (minAtual < 30 || minAtual > 78) analyzer.addMissing('LAY_1x1', "janelaTempo - Janela 30'-78'", `${minAtual}'`);
        analyzer.addExpected('LAY_1x1', 'placar!=1-1 - Placar atual deve ser 1-1', jogo.placar || 'N/D');
        if (!(gC === 1 && gF === 1)) analyzer.addMissing('LAY_1x1', 'placar!=1-1 - Placar atual deve ser 1-1', jogo.placar || 'N/D');
        const atqCombinado11 = jogo.momentum.ataquesCasa + jogo.momentum.ataquesFora;
        analyzer.addExpected('LAY_1x1', 'pressao<1.0 - Pressão total ≥ 1.0', jogo.pressao);
        if (jogo.pressao < 1.0) analyzer.addMissing('LAY_1x1', 'pressao<1.0 - Pressão total ≥ 1.0', jogo.pressao);
        analyzer.addExpected('LAY_1x1', 'atqCombinado<10 - Ataques combinados ≥ 10', atqCombinado11);
        if (atqCombinado11 < 10) analyzer.addMissing('LAY_1x1', 'atqCombinado<10 - Ataques combinados ≥ 10', atqCombinado11);
        const chutesCombinados = jogo.momentum.chutesNoAlvoCasa + jogo.momentum.chutesNoAlvoFora;
        analyzer.addExpected('LAY_1x1', 'chutesCombinados<2 - Chutes ao alvo combinados ≥ 2', chutesCombinados);
        if (chutesCombinados < 2) analyzer.addMissing('LAY_1x1', 'chutesCombinados<2 - Chutes ao alvo combinados ≥ 2', chutesCombinados);
        const ratio11 = (apmCasa > 0 && apmFora > 0) ? Math.max(apmCasa, apmFora) / Math.min(apmCasa, apmFora) : 0;
        analyzer.addExpected('LAY_1x1', 'ratio<1.8 - Dominância ≥ 1.8x', ratio11);
        if (ratio11 < 1.8) analyzer.addMissing('LAY_1x1', 'ratio<1.8 - Dominância ≥ 1.8x', ratio11);
        const qualDominante11 = apmCasa >= apmFora ? qualCasa : qualFora;
        analyzer.addExpected('LAY_1x1', 'qualidadeBaixa - Qualidade do ataque ≥ 20%', Math.round(qualDominante11*100));
        if (qualDominante11 < 0.20) analyzer.addMissing('LAY_1x1', 'qualidadeBaixa - Qualidade do ataque ≥ 20%', Math.round(qualDominante11*100));
        if (!emCooldown && !alertas.lay11 && minAtual >= 30 && minAtual <= 78) {
            if (gC === 1 && gF === 1) {
                const atqCombinado     = jogo.momentum.ataquesCasa + jogo.momentum.ataquesFora;
                const chutesCombinados = jogo.momentum.chutesNoAlvoCasa + jogo.momentum.chutesNoAlvoFora;
                const ratio = (apmCasa > 0 && apmFora > 0)
                    ? Math.max(apmCasa, apmFora) / Math.min(apmCasa, apmFora) : 0;
                const equipaDominante  = apmCasa >= apmFora ? 'CASA' : 'FORA';
                const qualDominante    = apmCasa >= apmFora ? qualCasa : qualFora;
                    if (jogo.pressao >= 1.0 && atqCombinado >= 10 && chutesCombinados >= 2 &&
                    ratio >= 1.8 && qualDominante >= 0.20) {
                    alertas.lay11 = true;
                        analyzer.setMet('LAY_1x1');
                    const msg = `🎯 *WOLF QUANT - LAY 1x1*\n🏟️ ${jogo.nomePartida}\n⏱️ ${minAtual}' | xG: ${jogo.xgCasa.toFixed(2)}-${jogo.xgFora.toFixed(2)}\n📊 APM Total: ${jogo.pressao.toFixed(2)} | Dominância: ${equipaDominante} (${ratio.toFixed(1)}x)\n🔬 AtqP Combinado: ${atqCombinado} | Chutes Alvo: ${chutesCombinados} | Qualidade: ${(qualDominante*100).toFixed(0)}%\n💡 ${equipaDominante === 'CASA' ? 'Casa' : 'Fora'} a dominar — próximo gol esperado`;
                    require('./logger').enviarAlertaTelegram(idJogo, jogo, msg, "LAY_1x1");
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

        // analysis snapshot is attached to jogo._engineAnalysis and will be sent by logger; no extra debug prints here
    }
}

module.exports = { processarMotorDeRegras };
