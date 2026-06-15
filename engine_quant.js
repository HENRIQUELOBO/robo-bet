// engine_quant.js

/**
 * Motor Matemático e Computacional Lobo Quant
 * Gerencia o cálculo de xG, Pressão Dinâmica (AP/Min) e o Momentum Micro (10 minutos)
 */

function calcularPressaoAPM(historico, tempoAtual) {
    if (tempoAtual <= 0) return 0;
    // Filtra os ataques perigosos ocorridos estritamente nos últimos 5 minutos para o cálculo de calor
    const limiteEstrategico = Math.max(0, tempoAtual - 5);
    const eventosRecentes = historico.filter(min => min > limiteEstrategico);
    return eventosRecentes.length / 5;
}

function calcularMomentumMicro10(historico, tempoAtual) {
    if (tempoAtual <= 0) return 0;
    // Escopo estrito do Quadro 2: Últimos 10 minutos de jogo corrido
    const limiteMicro = Math.max(0, tempoAtual - 10);
    const eventosMicro = historico.filter(min => min > limiteMicro);
    return eventosMicro.length;
}

function processarMotorDeRegras(idJogo, jogo, alertas) {
    const minAtual = jogo.tempo;

    // 🔬 TRAVA ANTI-FANTASMA DO INTERVALO (Filtro de transição de tempo HT/2T)
    if (jogo.noIntervalo && !jogo.momentumResetado2T) {
        // 1. Purga completa dos arrays históricos para o 2º tempo começar limpo (Zera o acúmulo do xG)
        jogo.historicoAtqCasa = [];
        jogo.historicoAtqFora = [];
        jogo.historicoEscCasa = [];
        jogo.historicoEscFora = [];
        jogo.historicoChAlvoCasa = [];
        jogo.historicoChAlvoFora = [];
        jogo.historicoChForaCasa = [];
        jogo.historicoChForaFora = [];

        // 2. Reseta o Objeto de apresentação do Quadro 2 (Micro 10m)
        jogo.momentum = {
            ataquesCasa: 0,
            ataquesFora: 0,
            escanteiosCasa: 0,
            escanteiosFora: 0,
            chutesNoAlvoCasa: 0,
            chutesNoAlvoFora: 0,
            chutesParaForaCasa: 0,
            chutesParaForaFora: 0
        };

        // 3. Ativa a trava de segurança para rodar apenas uma vez durante o intervalo
        jogo.momentumResetado2T = true;
    }

    // Se a bola voltou a rolar no 2º tempo (fora do intervalo), libera a trava
    if (!jogo.noIntervalo && minAtual > 45 && jogo.momentumResetado2T) {
        jogo.momentumResetado2T = false; 
    }

    // --- BLOCO MATEMÁTICO CORE ---
    
    // 1. Cálculo do APM de Pressão Dinâmica (Janela móvel de 5 minutos)
    const apmCasa = calcularPressaoAPM(jogo.historicoAtqCasa, minAtual);
    const apmFora = calcularPressaoAPM(jogo.historicoAtqFora, minAtual);
    jogo.pressao = apmCasa + apmFora;

    // 2. Atualização dos dados de Momentum Real para o Quadro 2 (Últimos 10 minutos)
    jogo.momentum.ataquesCasa = calcularMomentumMicro10(jogo.historicoAtqCasa, minAtual);
    jogo.momentum.ataquesFora = calcularMomentumMicro10(jogo.historicoAtqFora, minAtual);
    jogo.momentum.escanteiosCasa = calcularMomentumMicro10(jogo.historicoEscCasa, minAtual);
    jogo.momentum.escanteiosFora = calcularMomentumMicro10(jogo.historicoEscFora, minAtual);
    jogo.momentum.chutesNoAlvoCasa = calcularMomentumMicro10(jogo.historicoChAlvoCasa, minAtual);
    jogo.momentum.chutesNoAlvoFora = calcularMomentumMicro10(jogo.historicoChAlvoFora, minAtual);
    jogo.momentum.chutesParaForaCasa = calcularMomentumMicro10(jogo.historicoChForaCasa, minAtual);
    jogo.momentum.chutesParaForaFora = calcularMomentumMicro10(jogo.historicoChForaFora, minAtual);

    // 3. Algoritmo de Precificação de xG Proprietário Lobo Dev (MANTIDO PESOS ORIGINAIS)
    const pesoChAlvo = 0.35;
    const pesoChFora = 0.15;
    const pesoEsc = 0.08;
    const pesoAtqPerigoso = 0.02;

    // 🎯 CORREÇÃO CIRÚRGICA: Vincula o cálculo ao comprimento real (.length) dos históricos na RAM.
    // Impede que variáveis absolutas distorcidas ou reiniciadas pelo DOM do radar estourem a métrica.
    jogo.xgCasa = (jogo.historicoChAlvoCasa.length * pesoChAlvo) + 
                  (jogo.historicoChForaCasa.length * pesoChFora) + 
                  (jogo.historicoEscCasa.length * pesoEsc) + 
                  (jogo.historicoAtqCasa.length * pesoAtqPerigoso);

    jogo.xgFora = (jogo.historicoChAlvoFora.length * pesoChAlvo) + 
                  (jogo.historicoChForaFora.length * pesoChFora) + 
                  (jogo.historicoEscFora.length * pesoEsc) + 
                  (jogo.historicoAtqFora.length * pesoAtqPerigoso);

    // --- ENGINE DE DISPARO DE ALERTAS (MANTIDO 100% ORIGINAL E INTACTO) ---
    if (!jogo.noIntervalo && alertas) {
        // Regra do 1º Tempo: Janela entre os minutos 15' e 40'
        if (minAtual >= 15 && minAtual <= 40 && !alertas.golIminente1T) {
            if (jogo.momentum.ataquesCasa >= 12 && jogo.momentum.chutesNoAlvoCasa >= 2) {
                alertas.golIminente1T = true;
                const msg = `🔥 *WOLF QUANT - GATILHO 1T*\n🏟️ Partida: ${jogo.nomePartida}\n⏱️ Minuto: ${minAtual}'\n📊 Pressão: ${jogo.pressao.toFixed(2)} AP/Min\n🔬 AtqP (10m): ${jogo.momentum.ataquesCasa}\n⚽ Alvo (10m): ${jogo.momentum.chutesNoAlvoCasa}`;
                const { enviarAlertaTelegram } = require('./logger');
                enviarAlertaTelegram(idJogo, jogo, msg, "GATILHO_1T");
            }
        }

        // Regra do 2º Tempo: Janela entre os minutos 60' e 85'
        if (minAtual >= 60 && minAtual <= 85 && !alertas.golIminente2T) {
            if (jogo.momentum.ataquesCasa >= 15 && (jogo.momentum.chutesNoAlvoCasa + jogo.momentum.escanteiosCasa) >= 4) {
                alertas.golIminente2T = true;
                const msg = `🚨 *WOLF QUANT - GATILHO 2T*\n🏟️ Partida: ${jogo.nomePartida}\n⏱️ Minuto: ${minAtual}'\n📊 Pressão: ${jogo.pressao.toFixed(2)} AP/Min\n🔬 AtqP (10m): ${jogo.momentum.ataquesCasa}\n🎯 Pressão Total 2T Ativada`;
                const { enviarAlertaTelegram } = require('./logger');
                enviarAlertaTelegram(idJogo, jogo, msg, "GATILHO_2T");
            }
        }
    }
}

module.exports = { processarMotorDeRegras };