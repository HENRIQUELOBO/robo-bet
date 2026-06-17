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

function processarMotorDeRegras(idJogo, jogo, alertas) {
    const minAtual = jogo.tempo;

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
        jogo.momentumResetado2T = true;
    }
    if (!jogo.noIntervalo && minAtual > 45 && jogo.momentumResetado2T) jogo.momentumResetado2T = false;

    // --- BLOCO MATEMÁTICO CORE ---
    const apmCasa = calcularPressaoAPM(jogo.historicoAtqCasa, minAtual);
    const apmFora = calcularPressaoAPM(jogo.historicoAtqFora, minAtual);
    jogo.pressao  = apmCasa + apmFora;

    jogo.momentum.ataquesCasa        = calcularMomentumMicro10(jogo.historicoAtqCasa, minAtual);
    jogo.momentum.ataquesFora        = calcularMomentumMicro10(jogo.historicoAtqFora, minAtual);
    jogo.momentum.escanteiosCasa     = calcularMomentumMicro10(jogo.historicoEscCasa, minAtual);
    jogo.momentum.escanteiosFora     = calcularMomentumMicro10(jogo.historicoEscFora, minAtual);
    jogo.momentum.chutesNoAlvoCasa   = calcularMomentumMicro10(jogo.historicoChAlvoCasa, minAtual);
    jogo.momentum.chutesNoAlvoFora   = calcularMomentumMicro10(jogo.historicoChAlvoFora, minAtual);
    jogo.momentum.chutesParaForaCasa = calcularMomentumMicro10(jogo.historicoChForaCasa, minAtual);
    jogo.momentum.chutesParaForaFora = calcularMomentumMicro10(jogo.historicoChForaFora, minAtual);

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
                const ctx = difGols < 0 ? '🔴 Casa a perder' : difGols === 0 ? '🟡 Empate' : '🟢 Casa +1';
                const posse = jogo.posseBolaCasa ? ` | Posse Casa: ${jogo.posseBolaCasa}%` : '';
                const msg = `🔥 *WOLF QUANT - GATILHO 1T CASA*\n🏟️ ${jogo.nomePartida}\n⏱️ ${minAtual}' | ${ctx}${posse}\n📊 APM Casa: ${apmCasa.toFixed(2)} | Aceleração: ${acCasa > 0 ? '+' : ''}${acCasa} | xG: ${jogo.xgCasa.toFixed(2)}-${jogo.xgFora.toFixed(2)}\n🔬 AtqP: ${jogo.momentum.ataquesCasa} | Chutes Alvo: ${jogo.momentum.chutesNoAlvoCasa} | Qualidade: ${(qualCasa*100).toFixed(0)}%`;
                require('./logger').enviarAlertaTelegram(idJogo, jogo, msg, "GATILHO_1T");
            }
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
                const ctx = difGols > 0 ? '🔴 Fora a perder' : difGols === 0 ? '🟡 Empate' : '🟢 Fora +1';
                const posse = jogo.posseBolaFora ? ` | Posse Fora: ${jogo.posseBolaFora}%` : '';
                const msg = `🔥 *WOLF QUANT - GATILHO 1T FORA*\n🏟️ ${jogo.nomePartida}\n⏱️ ${minAtual}' | ${ctx}${posse}\n📊 APM Fora: ${apmFora.toFixed(2)} | Aceleração: ${acFora > 0 ? '+' : ''}${acFora} | xG: ${jogo.xgCasa.toFixed(2)}-${jogo.xgFora.toFixed(2)}\n🔬 AtqP Fora: ${jogo.momentum.ataquesFora} | Chutes Alvo: ${jogo.momentum.chutesNoAlvoFora} | Qualidade: ${(qualFora*100).toFixed(0)}%`;
                require('./logger').enviarAlertaTelegram(idJogo, jogo, msg, "GATILHO_1T_FORA");
            }
        }

        // ─────────────────────────────────────────────────────────────────
        // MÉTODO 3 — GATILHO 2T CASA: Casa pressiona no 2ºT (58'–85')
        // Score: casa a perder ou empate (sem valor se já a ganhar)
        // ─────────────────────────────────────────────────────────────────
        if (!emCooldown && minAtual >= 58 && minAtual <= 85 && !alertas.golIminente2T) {
            if (difGols <= 0 &&
                jogo.momentum.ataquesCasa >= 12 &&
                (jogo.momentum.chutesNoAlvoCasa + jogo.momentum.escanteiosCasa) >= 3 &&
                acCasa >= 0 && qualCasa >= 0.18) {
                alertas.golIminente2T = true;
                const ctx = difGols < 0 ? '🔴 Casa a perder' : '🟡 Empate';
                const msg = `🚨 *WOLF QUANT - GATILHO 2T*\n🏟️ ${jogo.nomePartida}\n⏱️ ${minAtual}' | ${ctx} | xG: ${jogo.xgCasa.toFixed(2)}-${jogo.xgFora.toFixed(2)}\n📊 APM Casa: ${apmCasa.toFixed(2)} | Aceleração: ${acCasa > 0 ? '+' : ''}${acCasa}\n🔬 AtqP: ${jogo.momentum.ataquesCasa} | Ch+Esc: ${jogo.momentum.chutesNoAlvoCasa + jogo.momentum.escanteiosCasa}`;
                require('./logger').enviarAlertaTelegram(idJogo, jogo, msg, "GATILHO_2T");
            }
        }

        // ─────────────────────────────────────────────────────────────────
        // MÉTODO 3 — GATILHO 2T FORA: Equipa visitante pressiona no 2ºT
        // ✅ NOVO: Sistema era cego à equipa visitante — corrigido
        // Score: fora a perder ou empate
        // ─────────────────────────────────────────────────────────────────
        if (!emCooldown && minAtual >= 58 && minAtual <= 85 && !alertas.golIminente2TFora) {
            if (difGols >= 0 &&   // fora a perder (difGols>0) ou empate (=0)
                jogo.momentum.ataquesFora >= 12 &&
                (jogo.momentum.chutesNoAlvoFora + jogo.momentum.escanteiosFora) >= 3 &&
                acFora >= 0 && qualFora >= 0.18) {
                alertas.golIminente2TFora = true;
                const ctx = difGols > 0 ? '🔴 Fora a perder' : '🟡 Empate';
                const msg = `🚨 *WOLF QUANT - GATILHO 2T FORA*\n🏟️ ${jogo.nomePartida}\n⏱️ ${minAtual}' | ${ctx} | xG: ${jogo.xgCasa.toFixed(2)}-${jogo.xgFora.toFixed(2)}\n📊 APM Fora: ${apmFora.toFixed(2)} | Aceleração: ${acFora > 0 ? '+' : ''}${acFora}\n🔬 AtqP Fora: ${jogo.momentum.ataquesFora} | Ch+Esc: ${jogo.momentum.chutesNoAlvoFora + jogo.momentum.escanteiosFora}`;
                require('./logger').enviarAlertaTelegram(idJogo, jogo, msg, "GATILHO_2T_FORA");
            }
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
                // Posse ≥ 55% é confirmatório mas não obrigatório (pode ser 0 se não scraped)
                const posseConfirma   = posseDominante >= 55 || posseDominante === 50; // 50 = default (sem dado)
                if (ratio >= 2.0 && apmDominante >= 0.8 && atqDominante >= 8 &&
                    qualDominante >= 0.18 && posseConfirma) {
                    alertas.layDraw = true;
                    const posseLabel = posseDominante !== 50 ? ` | Posse ${equipaDominante}: ${posseDominante}%` : '';
                    const msg = `🏆 *WOLF QUANT - LAY THE DRAW*\n🏟️ ${jogo.nomePartida}\n⏱️ ${minAtual}' | Score: ${jogo.placar} | xG: ${jogo.xgCasa.toFixed(2)}-${jogo.xgFora.toFixed(2)}\n📊 APM ${equipaDominante}: ${apmDominante.toFixed(2)} | Dominância: ${ratio.toFixed(1)}x${posseLabel}\n🔬 AtqP: ${atqDominante} | Qualidade: ${(qualDominante*100).toFixed(0)}%\n💡 Mercado: LAY DRAW (1x2) — ${equipaDominante} a dominar`;
                    require('./logger').enviarAlertaTelegram(idJogo, jogo, msg, "LAY_DRAW");
                }
            }
        }

        // ─────────────────────────────────────────────────────────────────
        // MÉTODO 7 — LAY 0x0: Pressão crescente com score a zeros (20'–65')
        // Mercado: Correct Score. Complementa o LAY DRAW no mercado de 1x2.
        // ─────────────────────────────────────────────────────────────────
        if (!emCooldown && !alertas.lay00 && minAtual >= 20 && minAtual <= 65) {
            if (gC === 0 && gF === 0) {
                const atqCombinado = jogo.momentum.ataquesCasa + jogo.momentum.ataquesFora;
                // Exige que PELO MENOS UMA equipa tenha qualidade ≥ 0.20
                const qualidadeReal = Math.max(qualCasa, qualFora) >= 0.20;
                if (jogo.pressao >= 1.0 && atqCombinado >= 8 && qualidadeReal &&
                    (acCasa + acFora) >= 0) {
                    alertas.lay00 = true;
                    const equipa = apmCasa >= apmFora ? 'CASA' : 'FORA';
                    const msg = `🔵 *WOLF QUANT - LAY 0x0*\n🏟️ ${jogo.nomePartida}\n⏱️ ${minAtual}' | xG: ${jogo.xgCasa.toFixed(2)}-${jogo.xgFora.toFixed(2)}\n📊 APM Total: ${jogo.pressao.toFixed(2)} | Dominante: ${equipa}\n🔬 AtqP Combinado: ${atqCombinado} | Qualidade máx: ${(Math.max(qualCasa,qualFora)*100).toFixed(0)}%\n💡 Pressão crescente — lay no 0-0`;
                    require('./logger').enviarAlertaTelegram(idJogo, jogo, msg, "LAY_0x0");
                }
            }
        }

        // ─────────────────────────────────────────────────────────────────
        // MÉTODO 7 — LAY 0x1: Casa perde 0-1 e pressiona (20'–82')
        // ✅ Aceleração ESTRITAMENTE > 0 (crescimento real, não estável)
        // ✅ Gate xG competitivo: casa deve ter criado ≥ 40% do xG da fora
        //    (evita entrar quando a fora merecia ganhar por muito mais)
        // ─────────────────────────────────────────────────────────────────
        if (!emCooldown && !alertas.lay01 && minAtual >= 20 && minAtual <= 82) {
            if (gC === 0 && gF === 1) {
                const xgCompetitivo = jogo.xgFora > 0
                    ? jogo.xgCasa >= jogo.xgFora * 0.40
                    : jogo.xgCasa >= 0.08;
                if (apmCasa >= 0.6 && jogo.momentum.ataquesCasa >= 6 &&
                    (jogo.momentum.chutesNoAlvoCasa + jogo.momentum.escanteiosCasa) >= 2 &&
                    qualCasa >= 0.20 && acCasa > 0 && xgCompetitivo) {
                    alertas.lay01 = true;
                    const msg = `⚡ *WOLF QUANT - LAY 0x1*\n🏟️ ${jogo.nomePartida}\n⏱️ ${minAtual}' | xG: ${jogo.xgCasa.toFixed(2)}-${jogo.xgFora.toFixed(2)}\n📊 APM Casa: ${apmCasa.toFixed(2)} | Aceleração: +${acCasa}\n🔬 AtqP: ${jogo.momentum.ataquesCasa} | Ch+Esc: ${jogo.momentum.chutesNoAlvoCasa + jogo.momentum.escanteiosCasa} | Qualidade: ${(qualCasa*100).toFixed(0)}%\n💡 Casa a pressionar — back no empate`;
                    require('./logger').enviarAlertaTelegram(idJogo, jogo, msg, "LAY_0x1");
                }
            }
        }

        // ─────────────────────────────────────────────────────────────────
        // MÉTODO 8 — LAY 1x0: Fora perde 1-0 e pressiona (20'–82')
        // ✅ Mirror profissional do LAY 0x1 com gate xG competitivo
        // ─────────────────────────────────────────────────────────────────
        if (!emCooldown && !alertas.lay10 && minAtual >= 20 && minAtual <= 82) {
            if (gC === 1 && gF === 0) {
                const xgCompetitivo = jogo.xgCasa > 0
                    ? jogo.xgFora >= jogo.xgCasa * 0.40
                    : jogo.xgFora >= 0.08;
                if (apmFora >= 0.6 && jogo.momentum.ataquesFora >= 6 &&
                    (jogo.momentum.chutesNoAlvoFora + jogo.momentum.escanteiosFora) >= 2 &&
                    qualFora >= 0.20 && acFora > 0 && xgCompetitivo) {
                    alertas.lay10 = true;
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
                        const equipa     = casaFavoritaPerdendo ? 'CASA' : 'FORA';
                        const oddFav     = casaFavoritaPerdendo ? odds.oddCasaBack : odds.oddForaBack;
                        const oddAzarao  = casaFavoritaPerdendo ? odds.oddForaLay  : odds.oddCasaLay;
                        const apmFav     = casaFavoritaPerdendo ? apmCasa : apmFora;
                        const atqFav     = casaFavoritaPerdendo ? jogo.momentum.ataquesCasa : jogo.momentum.ataquesFora;
                        const qualFav    = casaFavoritaPerdendo ? qualCasa : qualFora;
                        const msg = `🔄 *WOLF QUANT - FAVORITO VIRA*\n🏟️ ${jogo.nomePartida}\n⏱️ ${minAtual}' | Score: ${jogo.placar} | xG: ${jogo.xgCasa.toFixed(2)}-${jogo.xgFora.toFixed(2)}\n📈 Odd ${equipa}: ${oddFav} | Lay Azarão: ${oddAzarao || 'N/D'}\n🔬 APM ${equipa}: ${apmFav.toFixed(2)} | AtqP: ${atqFav} | Qualidade: ${(qualFav*100).toFixed(0)}%\n💡 Favorito a pressionar — BACK ${equipa} ou LAY no adversário`;
                        require('./logger').enviarAlertaTelegram(idJogo, jogo, msg, "FAVORITO_VIRA");
                    }
                }
            }
        }
    }
}

module.exports = { processarMotorDeRegras };