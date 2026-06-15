const puppeteer = require('puppeteer');
const axios = require('axios');
const readline = require('readline');
const path = require('path');
const fs = require('fs');

// CONFIGURAÇÕES DO TELEGRAM
const TELEGRAM_TOKEN = '8993868844:AAFokLp2D0gtqzrfACqpfzpwhXVk3J-Ewpc';
const TELEGRAM_CHAT_ID = '6873288591';

// Caminhos dos arquivos de auditoria e logs
const CAMINHO_LOG_CSV = path.join(__dirname, 'historico_gatilhos.csv');

// Objeto global para gerenciar o estado da telemetria
let estadoDoJogo = {
    nomePartida: 'Carregando...',
    tempo: 0,
    placar: '0-0',
    // 🌍 MÓDULO TOTAL (MACRO - JOGO INTEIRO)
    ataquesPerigososCasa: 0, ataquesPerigososFora: 0,
    escanteiosCasa: 0, escanteiosFora: 0,
    chutesNoAlvoCasa: 0, chutesNoAlvoFora: 0,
    chutesParaForaCasa: 0, chutesParaForaFora: 0,
    posseBolaCasa: 50, posseBolaFora: 50,
    pressao: 0.00,
    xgCasa: 0.00,
    xgFora: 0.00,

    // 🔬 MÓDULO MOMENTUM (MICRO - ÚLTIMOS 10 MINUTOS)
    momentum: {
        ataquesCasa: 0, ataquesFora: 0,
        escanteiosCasa: 0, escanteiosFora: 0,
        chutesNoAlvoCasa: 0, chutesNoAlvoFora: 0,
        chutesParaForaCasa: 0, chutesParaForaFora: 0
    },

    // Buffers em memória para carimbo de timestamps
    historicoAtqCasa: [], historicoAtqFora: [],
    historicoEscCasa: [], historicoEscFora: [],
    historicoChAlvoCasa: [], historicoChAlvoFora: [],
    historicoChForaCasa: [], historicoChForaFora: []
};

let alertasDisparados = {
    metodo1: false,
    metodo2: false,
    metodo3: false,
    golIminente1T: false,
    golIminente2T: false
};

// Travas de controle de fluxo
let sincronizadoComFeed = false;
let ultimosAlertasConsole = [];
let noIntervalo = false; // Flag dinâmica para controle do HT

// Configura o terminal para comandos em tempo real
readline.emitKeypressEvents(process.stdin);
if (process.stdin.isTTY) {
    process.stdin.setRawMode(true);
}

// 📝 ENGINE 1: Dump Time-Series Dinâmico (Cria um arquivo .txt exclusivo por jogo e data)
function registrarTelemetriaContinua() {
    try {
        // Se ainda não carregou o nome dos times no scraper, aguarda o próximo ciclo
        if (!estadoDoJogo.nomePartida || estadoDoJogo.nomePartida.includes('Carregando')) return;

        const dataAtual = new Date();
        const dataFormatada = dataAtual.toLocaleDateString('pt-BR').replace(/\//g, '-'); // Ex: 13-06-2026
        const horaMinutoSegundo = dataAtual.toLocaleTimeString('pt-BR');

        // Sanitiza o nome do jogo para não quebrar o sistema de ficheiros do Linux
        const nomeJogoSanitizado = estadoDoJogo.nomePartida
            .replace(/\s+/g, '_')            // Troca espaços por _
            .replace(/[^a-zA-Z0-9_v]/g, ''); // Remove símbolos e acentos complexos

        // Nome do arquivo dinâmico gerado em tempo de execução
        const nomeArquivoDinamico = `telemetria_${nomeJogoSanitizado}_${dataFormatada}.txt`;
        const caminhoCompletoTxt = path.join(__dirname, nomeArquivoDinamico);

        const { tempo, placar, pressao, xgCasa, xgFora, momentum } = estadoDoJogo;
        
        // Montagem da linha com metadados estruturados para o time-series bruto
        const logLinha = `[${horaMinutoSegundo}] | Min: ${tempo}' | Placar: ${placar} | APM Max: ${pressao.toFixed(2)} | xG C: ${xgCasa.toFixed(2)} - xG F: ${xgFora.toFixed(2)} | APM10m C/F: ${momentum.ataquesCasa}/${momentum.ataquesFora} | Chutes10m Alvo/Fora: (${momentum.chutesNoAlvoCasa}/${momentum.chutesNoAlvoFora}) (${momentum.chutesParaForaCasa}/${momentum.chutesParaForaFora})\n`;
        
        fs.appendFileSync(caminhoCompletoTxt, logLinha, 'utf8');
    } catch (err) {
        // Falha silenciosa para não quebrar o fluxo principal da máquina
    }
}

// 🏛️ ENGINE 2: Salva apenas a foto exata do mercado no CSV quando um sinal válido é disparado
async function registrarLogValidacao(metodoAtivado) {
    try {
        if (!fs.existsSync(CAMINHO_LOG_CSV)) {
            const cabecalho = "DATA_HORA;PARTIDA;METODO;TEMPO_DISPARO;PLACAR_MOMENTO;APM_MOMENTO;XG_MAX_MOMENTO;CHUTES_ALVO_10M;CHUTES_FORA_10M;TOTAL_FINALIZACOES_10M;RESULTADO_VALIDACAO (GREEN/RED)\n";
            fs.writeFileSync(CAMINHO_LOG_CSV, cabecalho, 'utf8');
        }

        const dataHoraAtual = new Date().toLocaleString('pt-BR');
        const { tempo, placar, pressao, momentum, xgCasa, xgFora } = estadoDoJogo;
        
        const cantos10m = momentum.escanteiosCasa + momentum.escanteiosFora;
        const chutesAlvo10m = momentum.chutesNoAlvoCasa + momentum.chutesNoAlvoFora;
        const chutesFora10m = momentum.chutesParaForaCasa + momentum.chutesParaForaFora;
        const totalFinalizacoes10m = chutesAlvo10m + chutesFora10m;
        const xgMax = Math.max(xgCasa, xgFora);

        const nomePartidaSanitizado = estadoDoJogo.nomePartida.replace(/;/g, '-');
        const linhaLog = `${dataHoraAtual};${nomePartidaSanitizado};${metodoAtivado};${tempo};${placar};${pressao.toFixed(2)};${xgMax.toFixed(2)};${cantos10m};${chutesAlvo10m};${chutesFora10m};${totalFinalizacoes10m};\n`;

        fs.appendFileSync(CAMINHO_LOG_CSV, linhaLog, 'utf8');
    } catch (err) {
        // Falha silenciosa
    }
}

async function enviarAlertaTelegram(mensagem, metodoAtivado) {
    if (TELEGRAM_TOKEN === 'SEU_BOT_TOKEN_AQUI') return;
    const url = `https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`;
    try {
        await axios.post(url, { chat_id: TELEGRAM_CHAT_ID, text: message = mensagem, parse_mode: 'Markdown' });
        await registrarLogValidacao(metodoAtivado);

        const hora = new Date().toLocaleTimeString('pt-BR');
        ultimosAlertasConsole.unshift(`[${hora}] 🚀 TELEGRAM & CSV REGISTRADOS: ${metodoAtivado} (${estadoDoJogo.placar})`);
        if (ultimosAlertasConsole.length > 3) ultimosAlertasConsole.pop();
    } catch (e) {
        // Silencioso
    }
}

function renderizarPainelTerminal(limpar = true) {
    if (limpar) console.clear();

    console.log("====================================================================");
    console.log("🐺 LOBO DEV - MONITOR DE TELEMETRIA QUANT (BYPASS PADRÃO EUROPEU)");
    console.log("====================================================================");
    console.log(`🏟️ Partida:       ${estadoDoJogo.nomePartida}`);
    
    if (noIntervalo) {
        console.log(`⏱️ Tempo de Jogo:  ⏸️ JOGO NO INTERVALO (Filtros e Logs Pausados)`);
    } else {
        console.log(`⏱️ Tempo de Jogo:  ${estadoDoJogo.tempo}' min`);
    }
    
    console.log(`⚽ Placar Atual:   ${estadoDoJogo.placar}`);
    console.log(`⚡ Pressão Máx:   ${estadoDoJogo.pressao.toFixed(2)} AP/Min`);
    console.log(`📊 xG Estimado:   Casa: ${estadoDoJogo.xgCasa.toFixed(2)} | Visitante: ${estadoDoJogo.xgFora.toFixed(2)}`);
    
    console.log("--------------------------------------------------------------------");
    console.log("📊 QUADRO 1: TELEMETRIA TOTAL (MACRO - JOGO COMPLETO)");
    console.log("--------------------------------------------------------------------");
    console.log(`📈 Atq. Perigosos:  Casa: ${estadoDoJogo.ataquesPerigososCasa} | Visitante: ${estadoDoJogo.ataquesPerigososFora}`);
    console.log(`📐 Escanteios:      Casa: ${estadoDoJogo.escanteiosCasa} | Visitante: ${estadoDoJogo.escanteiosFora}`);
    console.log(`🎯 Chutes no Alvo:  Casa: ${estadoDoJogo.chutesNoAlvoCasa} | Visitante: ${estadoDoJogo.chutesNoAlvoFora}`);
    console.log(`0️⃣ Chutes p/ Fora:  Casa: ${estadoDoJogo.chutesParaForaCasa} | Visitante: ${estadoDoJogo.chutesParaForaFora}`);
    console.log(`🔄 Posse de Bola:   Casa: ${estadoDoJogo.posseBolaCasa}% | Visitante: ${estadoDoJogo.posseBolaFora}%`);
    
    console.log("--------------------------------------------------------------------");
    console.log("🔬 QUADRO 2: MOMENTUM REAL (MICRO - ÚLTIMOS 10 MINUTOS)");
    console.log("--------------------------------------------------------------------");
    console.log(`📈 Atq. Perigosos:  Casa: ${estadoDoJogo.momentum.ataquesCasa} | Visitante: ${estadoDoJogo.momentum.ataquesFora}`);
    console.log(`📐 Escanteios:      Casa: ${estadoDoJogo.momentum.escanteiosCasa} | Visitante: ${estadoDoJogo.momentum.escanteiosFora}`);
    console.log(`🎯 Chutes no Alvo:  Casa: ${estadoDoJogo.momentum.chutesNoAlvoCasa} | Visitante: ${estadoDoJogo.momentum.chutesNoAlvoFora}`);
    console.log(`0️⃣ Chutes p/ Fora:  Casa: ${estadoDoJogo.momentum.chutesParaForaCasa} | Visitante: ${estadoDoJogo.momentum.chutesParaForaFora}`);
    
    console.log("====================================================================");
    console.log("🔔 AUDITORIA LIVE: ÚLTIMOS GATILHOS DETECTADOS E PROCESSADOS");
    console.log("--------------------------------------------------------------------");
    if (ultimosAlertasConsole.length === 0) {
        console.log(" 🔍 Escaneando mercado... Aguardando primeiro sinal de valor... ");
    } else {
        ultimosAlertasConsole.forEach(alerta => console.log(` ${alerta}`));
    }
    console.log("====================================================================");
}

function processarMotorDeRegras() {
    const { tempo, placar, ataquesPerigososCasa, escanteiosCasa, escanteiosFora, chutesNoAlvoCasa, chutesNoAlvoFora, chutesParaForaCasa, chutesParaForaFora } = estadoDoJogo;

    if (tempo < 5) {
        estadoDoJogo.historicoAtqCasa = []; estadoDoJogo.historicoAtqFora = [];
        estadoDoJogo.historicoEscCasa = []; estadoDoJogo.historicoEscFora = [];
        estadoDoJogo.historicoChAlvoCasa = []; estadoDoJogo.historicoChAlvoFora = [];
        estadoDoJogo.historicoChForaCasa = []; estadoDoJogo.historicoChForaFora = [];
        estadoDoJogo.pressao = 0.00;
        estadoDoJogo.xgCasa = 0.00;
        estadoDoJogo.xgFora = 0.00;
        Object.keys(alertasDisparados).forEach(key => alertasDisparados[key] = false);
        return;
    }

    // Modelagem de Inteligência Matemática: Gols Esperados (xG Proprietário)
    estadoDoJogo.xgCasa = (chutesNoAlvoCasa * 0.16) + (chutesParaForaCasa * 0.06) + (escanteiosCasa * 0.03);
    estadoDoJogo.xgFora = (chutesNoAlvoFora * 0.16) + (chutesParaForaFora * 0.06) + (escanteiosFora * 0.03);
    const xgMaxAtual = Math.max(estadoDoJogo.xgCasa, estadoDoJogo.xgFora);

    // FILTRO DE LIMPEZA DE JANELA MÓVEL (Últimos 10 Minutos)
    const JANELA_MINUTOS = 10;
    const minutoCorte = tempo - JANELA_MINUTOS;

    estadoDoJogo.historicoAtqCasa = estadoDoJogo.historicoAtqCasa.filter(min => min > minutoCorte);
    estadoDoJogo.historicoAtqFora = estadoDoJogo.historicoAtqFora.filter(min => min > minutoCorte);
    estadoDoJogo.historicoEscCasa = estadoDoJogo.historicoEscCasa.filter(min => min > minutoCorte);
    estadoDoJogo.historicoEscFora = estadoDoJogo.historicoEscFora.filter(min => min > minutoCorte);
    estadoDoJogo.historicoChAlvoCasa = estadoDoJogo.historicoChAlvoCasa.filter(min => min > minutoCorte);
    estadoDoJogo.historicoChAlvoFora = estadoDoJogo.historicoChAlvoFora.filter(min => min > minutoCorte);
    estadoDoJogo.historicoChForaCasa = estadoDoJogo.historicoChForaCasa.filter(min => min > minutoCorte);
    estadoDoJogo.historicoChForaFora = estadoDoJogo.historicoChForaFora.filter(min => min > minutoCorte);

    // Sincroniza submódulo do Momentum
    estadoDoJogo.momentum.ataquesCasa = estadoDoJogo.historicoAtqCasa.length;
    estadoDoJogo.momentum.ataquesFora = estadoDoJogo.historicoAtqFora.length;
    estadoDoJogo.momentum.escanteiosCasa = estadoDoJogo.historicoEscCasa.length;
    estadoDoJogo.momentum.escanteiosFora = estadoDoJogo.historicoEscFora.length;
    estadoDoJogo.momentum.chutesNoAlvoCasa = estadoDoJogo.historicoChAlvoCasa.length;
    estadoDoJogo.momentum.chutesNoAlvoFora = estadoDoJogo.historicoChAlvoFora.length;
    estadoDoJogo.momentum.chutesParaForaCasa = estadoDoJogo.historicoChForaCasa.length;
    estadoDoJogo.momentum.chutesParaForaFora = estadoDoJogo.historicoChForaFora.length;

    // APM da Janela Móvel (Cálculo de Pressão Máxima)
    const apmCasaReal = estadoDoJogo.momentum.ataquesCasa / JANELA_MINUTOS;
    const apmForaReal = estadoDoJogo.momentum.ataquesFora / JANELA_MINUTOS;
    const pressaoCalculada = Math.max(apmCasaReal, apmForaReal);
    estadoDoJogo.pressao = pressaoCalculada;

    // Métricas combinadas totais (Macro)
    const totalChutesNoAlvo = chutesNoAlvoCasa + chutesNoAlvoFora;
    const totalFinalizacoes = totalChutesNoAlvo + chutesParaForaCasa + chutesParaForaFora; 
    const totalEscanteios = escanteiosCasa + escanteiosFora;

    // Trava do Presente: Exige pelo menos 1 finalização recente nos últimos 10 min
    const mChutesTotal10m = estadoDoJogo.momentum.chutesNoAlvoCasa + estadoDoJogo.momentum.chutesNoAlvoFora + estadoDoJogo.momentum.chutesParaForaCasa + estadoDoJogo.momentum.chutesParaForaFora;

    // 🔬 REFINO EUROPEU: BYPASS DE ELITE POR CHUTE NO ALVO E XG
    // Se o time dominante ataca por associação central (posse), ele chuta mais e cruza menos (menos cantos).
    // Se tiver >= 3 chutes no alvo (1T) ou >= 4 (2T) de um único lado, ou se o xG macro for esmagador, liberamos o bypass.
    const temChutesDominantes1T = (chutesNoAlvoCasa >= 3 || chutesNoAlvoFora >= 3);
    const temChutesDominantes2T = (chutesNoAlvoCasa >= 4 || chutesNoAlvoFora >= 4);
    const xgEliteMacro = (xgMaxAtual >= 1.00);

    // VALIDAÇÕES BASEADAS EM VOLUME, INTENSIDADE E QUALIDADE
    const volumeValido1T = (totalChutesNoAlvo >= 2 && totalFinalizacoes >= 5) || (xgMaxAtual >= 0.50); 
    const temAgressividadeHT = (totalEscanteios >= 3 && totalFinalizacoes >= 4) || (totalFinalizacoes >= 6 && temChutesDominantes1T) || (xgMaxAtual >= 0.60); 

    const volumeValido2T = (totalChutesNoAlvo >= 3 && totalFinalizacoes >= 6) || xgEliteMacro;
    const temAgressividadeFT = (totalEscanteios >= 4 && totalFinalizacoes >= 6) || (totalFinalizacoes >= 7 && temChutesDominantes2T) || (xgMaxAtual >= 1.20); 

    // O sarrafo padrão de pressão do 2T é 1.60. Se o jogo tiver xG de Elite ou Chutes dominantes na área, aceitamos reduzir o sarrafo para 0.80.
    const pressaoMinimaExigida2T = (temChutesDominantes2T || xgEliteMacro) ? 0.80 : 1.60;

    // MÉTODO 1 - O PREDESTINADO
    if (placar === '0-0' && tempo >= 15 && tempo <= 35 && apmCasaReal >= 1.3 && chutesNoAlvoCasa >= 2) {
        if (!alertasDisparados.metodo1) {
            enviarAlertaTelegram(`🎯 *GATILHO: MÉTODO 1 - O PREDESTINADO*\n🏟️ *Jogo:* ${estadoDoJogo.nomePartida}\n⏱️ *Tempo:* ${tempo}'\n⚽ *Placar:* ${placar}\n📈 *APM Real (10m):* ${apmCasaReal.toFixed(2)}\n📋 *Ação:* Entrar em *LAY 0x1*`, 'METODO_1_PREDESTINADO');
            alertasDisparados.metodo1 = true;
        }
    }

    // MÉTODO 2 - COLO DE PRESSÃO
    if (placar === '1-0' && tempo >= 46 && tempo <= 55 && apmCasaReal >= 1.2 && escanteiosCasa >= 4) {
        if (!alertasDisparados.metodo2) {
            enviarAlertaTelegram(`🎯 *GATILHO: MÉTODO 2 - COLO DE PRESSÃO*\n🏟️ *Jogo:* ${estadoDoJogo.nomePartida}\n⏱️ *Tempo:* ${tempo}'\n⚽ *Placar:* ${placar}\n📐 *Escanteios Casa:* ${escanteiosCasa}\n📋 *Ação:* *BACK 2x0* ou *LAY 1x1*`, 'METODO_2_COLO_PRESSAO');
            alertasDisparados.metodo2 = true;
        }
    }

    // 🔥 GOL IMINENTE - 1º TEMPO (JANELA HT COM BYPASS DE FINALIZAÇÕES CENTRAIS)
    if (tempo >= 20 && tempo <= 40 && pressaoCalculada >= 1.50 && volumeValido1T && temAgressividadeHT && mChutesTotal10m >= 1) {
        if (!alertasDisparados.golIminente1T) {
            enviarAlertaTelegram(`🔥 *ALERTA: GOL IMINENTE - 1º TEMPO*\n🏟️ *Jogo:* ${estadoDoJogo.nomePartida}\n⏱️ *Tempo:* ${tempo}'\n⚽ *Placar Atual:* ${placar}\n📈 *APM Máx:* ${pressaoCalculada.toFixed(2)} | *🤖 xG Máx:* ${xgMaxAtual.toFixed(2)}\n🎯 *No Alvo Total:* ${totalChutesNoAlvo} | *Total Chutes:* ${totalFinalizacoes}\n📋 *Ação:* *OVER GOLS HT*`, 'GOL_IMINENTE_1T');
            alertasDisparados.golIminente1T = true;
        }
    }

    // 🚨 GOL IMINENTE - 2º TEMPO (CALIBRAÇÃO DINÂMICA: SUCESSO EM ABALOS DE POSSE DE ELITE)
    if (tempo >= 55 && tempo <= 85 && pressaoCalculada >= pressaoMinimaExigida2T && volumeValido2T && temAgressividadeFT && mChutesTotal10m >= 1) {
        if (!alertasDisparados.golIminente2T) {
            enviarAlertaTelegram(`🚨 *ALERTA: GOL IMINENTE DETECTADO - 2º TEMPO*\n🏟️ *Jogo:* ${estadoDoJogo.nomePartida}\n⏱️ *Tempo Crítico:* ${tempo}'\n⚽ *Placar Atual:* ${placar}\n📈 *APM Máx:* ${pressaoCalculada.toFixed(2)} [Mín: ${pressaoMinimaExigida2T.toFixed(2)}] | *🤖 xG Máx:* ${xgMaxAtual.toFixed(2)}\n🎯 *No Alvo Total:* ${totalChutesNoAlvo} | *Total Chutes:* ${totalFinalizacoes}\n📋 *Ação:* Entrar em *OVER LIMITE*`, 'GOL_IMINENTE_2T');
            alertasDisparados.golIminente2T = true;
        }
    }
}

async function iniciarRobo() {
    renderizarPainelTerminal(false);
    const pastaSessao = path.join(__dirname, 'betfair_session');

    const browser = await puppeteer.launch({
        headless: false,
        defaultViewport: null,
        userDataDir: pastaSessao,
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-gpu']
    });

    const pageBetfair = await browser.newPage();
    const context = browser.defaultBrowserContext();
    await context.overridePermissions('https://www.betfair.com', ['geolocation']);
    await pageBetfair.setGeolocation({ latitude: -23.550520, longitude: -46.633308, accuracy: 100 });
    await pageBetfair.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36');

    console.log(`📡 Abrindo Betfair Exchange para execução...`);
    await pageBetfair.goto('https://www.betfair.com/exchange/plus/', { waitUntil: 'domcontentloaded' });

    const pageRadar = await browser.newPage();
    await pageRadar.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36');

    console.log(`\n🤖 ROBÔ QUANT PRONTO!`);
    console.log(`📋 Instruções: Selecione este terminal e pressione ESPAÇO para inserir a URL do jogo.`);

    let intervaloColeta = null;

    function abrirPromptUrl() {
        if (intervaloColeta) {
            clearInterval(intervaloColeta);
            intervaloColeta = null;
        }

        if (process.stdin.isTTY) process.stdin.setRawMode(false);
        process.stdin.pause();

        const rl = readline.createInterface({
            input: process.stdin,
            output: process.stdout,
            terminal: true
        });

        console.log("\n--------------------------------------------------------------------");
        rl.question('🔗 Cole a URL do jogo do RadarFutebol: ', async (urlDigitada) => {
            rl.close();

            if (process.stdin.isTTY) process.stdin.setRawMode(true);
            process.stdin.resume(); 

            const urlValida = urlDigitada.trim();
            if (!urlValida.startsWith('http')) {
                console.log("❌ URL Inválida! Pressione ESPAÇO para tentar novamente.");
                return;
            }

            sincronizadoComFeed = false;
            noIntervalo = false;

            estadoDoJogo = {
                nomePartida: 'Carregando metadados...', tempo: 0, placar: '0-0',
                ataquesPerigososCasa: 0, ataquesPerigososFora: 0,
                escanteiosCasa: 0, escanteiosFora: 0,
                chutesNoAlvoCasa: 0, chutesNoAlvoFora: 0,
                chutesParaForaCasa: 0, chutesParaForaFora: 0,
                posseBolaCasa: 50, posseBolaFora: 50, pressao: 0.00, xgCasa: 0.00, xgFora: 0.00,
                momentum: {
                    ataquesCasa: 0, ataquesFora: 0, escanteiosCasa: 0, escanteiosFora: 0,
                    chutesNoAlvoCasa: 0, chutesNoAlvoFora: 0, chutesParaForaCasa: 0, chutesParaForaFora: 0
                },
                historicoAtqCasa: [], historicoAtqFora: [],
                historicoEscCasa: [], historicoEscFora: [],
                historicoChAlvoCasa: [], historicoChAlvoFora: [],
                historicoChForaCasa: [], historicoChForaFora: []
            };

            Object.keys(alertasDisparados).forEach(k => alertasDisparados[k] = false);

            console.log(`⚡ Conectando Scraper ao novo feed: ${urlValida}...`);
            try {
                await pageRadar.goto(urlValida, { waitUntil: 'domcontentloaded' });
            } catch (err) {
                console.log("❌ Erro ao abrir a página. Pressione ESPAÇO para tentar outra URL.");
                return;
            }

            console.log("✅ Novo monitoramento com xG Proprietário ativo!");

            intervaloColeta = setInterval(async () => {
                try {
                    const dadosContexto = await pageRadar.evaluate(() => {
                        let info = { timeCasa: '', timeFora: '', tituloAba: document.title };
                        let rootDiv = document.querySelector('[wire\\:snapshot]');
                        if (rootDiv) {
                            try {
                                let snapshot = JSON.parse(rootDiv.getAttribute('wire:snapshot'));
                                if (snapshot && snapshot.data) {
                                    info.timeCasa = snapshot.data.timeCasa;
                                    info.timeFora = snapshot.data.timeFora;
                                }
                            } catch (e) {}
                        }
                        return info;
                    });

                    if (dadosContexto.timeCasa && dadosContexto.timeFora) {
                        estadoDoJogo.nomePartida = `${dadosContexto.timeCasa} v ${dadosContexto.timeFora}`;
                    } else if (dadosContexto.tituloAba) {
                        estadoDoJogo.nomePartida = dadosContexto.tituloAba.split('|')[0].trim();
                    }

                    const todosOsFrames = await pageRadar.frames();
                    let frameRadar = todosOsFrames.find(f => 
                        f.url().includes('radarfutebol.xyz/scoreboards') || 
                        f.name() === 'iframe-williamhill'
                    );

                    let contextoAlvo = frameRadar ? frameRadar : pageRadar;

                    const telemetriaRadar = await contextoAlvo.evaluate(() => {
                        let tempoLocal = 0;
                        let placarLocal = '';
                        let statusIntervalo = false;
                        let atqC = 0, atqF = 0, escC = 0, escF = 0, chC = 0, chF = 0, chForaC = 0, chForaF = 0;
                        let posseC = 50, posseF = 50;

                        let spanRelogio = document.querySelector('[data-push="clock"], .clockWrapper span');
                        if (spanRelogio && spanRelogio.textContent) {
                            let textoCru = spanRelogio.textContent.trim().toLowerCase();
                            
                            if (textoCru.includes('intervalo') || textoCru.includes('ht') || textoCru.includes('int')) {
                                statusIntervalo = true;
                                tempoLocal = 45; 
                            } else {
                                let matchHora = textoCru.match(/(\d{1,2}):(\d{2})/);
                                if (matchHora) {
                                    let m = parseInt(matchHora[1]) || 0;
                                    let s = parseInt(matchHora[2]) || 0;
                                    tempoLocal = s > 0 ? m + 1 : m;
                                }
                            }
                        }

                        let nósTextoIframe = Array.from(document.querySelectorAll('div, span, p, b'))
                            .map(el => el.textContent ? el.textContent.trim() : '');
                        let matchPlacar = nósTextoIframe.find(t => /^\d+\s*-\s*\d+$/.test(t));
                        if (matchPlacar) {
                            placarLocal = matchPlacar.replace(/\s+/g, '');
                        }

                        let wrapper = document.getElementById('stats_wrapper');
                        if (wrapper) {
                            let blocoAtq = wrapper.querySelector('[data-stat="dangerousAttacks"]');
                            if (blocoAtq) {
                                atqC = parseInt(blocoAtq.querySelector('.home')?.textContent || '0') || 0;
                                atqF = parseInt(blocoAtq.querySelector('.away')?.textContent || '0') || 0;
                            }

                            let blocoEsc = wrapper.querySelector('[data-stat="corners"]');
                            if (blocoEsc) {
                                escC = parseInt(blocoEsc.querySelector('.home')?.textContent || '0') || 0;
                                escF = parseInt(blocoEsc.querySelector('.away')?.textContent || '0') || 0;
                            }

                            let blocoChutes = wrapper.querySelector('[data-stat="shotsOnTarget"]');
                            if (blocoChutes) {
                                chC = parseInt(blocoChutes.querySelector('.home')?.textContent || '0') || 0;
                                chF = parseInt(blocoChutes.querySelector('.away')?.textContent || '0') || 0;
                            }

                            let blocoFora = wrapper.querySelector('[data-stat="shotsOffTarget"]');
                            if (blocoFora) {
                                chForaC = parseInt(blocoFora.querySelector('.home')?.textContent || '0') || 0;
                                chForaF = parseInt(blocoFora.querySelector('.away')?.textContent || '0') || 0;
                            }

                            let blocoPosse = wrapper.querySelector('[data-stat="possession"]');
                            if (blocoPosse) {
                                let txtCasa = blocoPosse.querySelector('.home')?.textContent || '50';
                                let txtFora = blocoPosse.querySelector('.away')?.textContent || '50';
                                posseC = parseInt(txtCasa.replace(/[^0-9]/g, '')) || 50;
                                posseF = parseInt(txtFora.replace(/[^0-9]/g, '')) || 50;
                            }
                        }

                        return { tempoLocal, placarLocal, statusIntervalo, atqC, atqF, escC, escF, chC, chF, chForaC, chForaF, posseC, posseF };
                    });

                    if (telemetriaRadar) {
                        if (telemetriaRadar.statusIntervalo) {
                            noIntervalo = true;
                            renderizarPainelTerminal(true);
                            return; 
                        }
                        
                        noIntervalo = false; 

                        if (telemetriaRadar.tempoLocal > 0 && telemetriaRadar.tempoLocal >= estadoDoJogo.tempo) {
                            estadoDoJogo.tempo = telemetriaRadar.tempoLocal;
                        }
                        if (telemetriaRadar.placarLocal && telemetriaRadar.placarLocal.includes('-')) {
                            estadoDoJogo.placar = telemetriaRadar.placarLocal;
                        }

                        let minutoAtual = estadoDoJogo.tempo;

                        // BLINDAGEM COLD START ANCORA O CACHE INICIAL
                        if (!sincronizadoComFeed) {
                            estadoDoJogo.ataquesPerigososCasa = telemetriaRadar.atqC;
                            estadoDoJogo.ataquesPerigososFora = telemetriaRadar.atqF;
                            estadoDoJogo.escanteiosCasa = telemetriaRadar.escC;
                            estadoDoJogo.escanteiosFora = telemetriaRadar.escF;
                            estadoDoJogo.chutesNoAlvoCasa = telemetriaRadar.chC;
                            estadoDoJogo.chutesNoAlvoFora = telemetriaRadar.chF;
                            estadoDoJogo.chutesParaForaCasa = telemetriaRadar.chForaC;
                            estadoDoJogo.chutesParaForaFora = telemetriaRadar.chForaF;
                            estadoDoJogo.posseBolaCasa = telemetriaRadar.posseC;
                            estadoDoJogo.posseBolaFora = telemetriaRadar.posseF;
                            
                            sincronizadoComFeed = true;
                            return;
                        }

                        // Monitor de Deltas do Fluxo (Janela Móvel)
                        if (telemetriaRadar.atqC > estadoDoJogo.ataquesPerigososCasa) {
                            let delta = telemetriaRadar.atqC - estadoDoJogo.ataquesPerigososCasa;
                            for (let i = 0; i < delta; i++) estadoDoJogo.historicoAtqCasa.push(minutoAtual);
                        }
                        if (telemetriaRadar.atqF > estadoDoJogo.ataquesPerigososFora) {
                            let delta = telemetriaRadar.atqF - estadoDoJogo.ataquesPerigososFora;
                            for (let i = 0; i < delta; i++) estadoDoJogo.historicoAtqFora.push(minutoAtual);
                        }

                        if (telemetriaRadar.escC > estadoDoJogo.escanteiosCasa) {
                            let delta = telemetriaRadar.escC - estadoDoJogo.escanteiosCasa;
                            for (let i = 0; i < delta; i++) estadoDoJogo.historicoEscCasa.push(minutoAtual);
                        }
                        if (telemetriaRadar.escF > estadoDoJogo.escanteiosFora) {
                            let delta = telemetriaRadar.escF - estadoDoJogo.escanteiosFora;
                            for (let i = 0; i < delta; i++) estadoDoJogo.historicoEscFora.push(minutoAtual);
                        }

                        if (telemetriaRadar.chC > estadoDoJogo.chutesNoAlvoCasa) {
                            let delta = telemetriaRadar.chC - estadoDoJogo.chutesNoAlvoCasa;
                            for (let i = 0; i < delta; i++) estadoDoJogo.historicoChAlvoCasa.push(minutoAtual);
                        }
                        if (telemetriaRadar.chF > estadoDoJogo.chutesNoAlvoFora) {
                            let delta = telemetriaRadar.chF - estadoDoJogo.chutesNoAlvoFora;
                            for (let i = 0; i < delta; i++) estadoDoJogo.historicoChAlvoFora.push(minutoAtual);
                        }

                        if (telemetriaRadar.chForaC > estadoDoJogo.chutesParaForaCasa) {
                            let delta = telemetriaRadar.chForaC - estadoDoJogo.chutesParaForaCasa;
                            for (let i = 0; i < delta; i++) estadoDoJogo.historicoChForaCasa.push(minutoAtual);
                        }
                        if (telemetriaRadar.chForaF > estadoDoJogo.chutesParaForaFora) {
                            let delta = telemetriaRadar.chForaF - estadoDoJogo.chutesParaForaFora;
                            for (let i = 0; i < delta; i++) estadoDoJogo.historicoChForaFora.push(minutoAtual);
                        }

                        // Sincroniza absolutos
                        estadoDoJogo.ataquesPerigososCasa = telemetriaRadar.atqC;
                        estadoDoJogo.ataquesPerigososFora = telemetriaRadar.atqF;
                        estadoDoJogo.escanteiosCasa = telemetriaRadar.escC;
                        estadoDoJogo.escanteiosFora = telemetriaRadar.escF;
                        estadoDoJogo.chutesNoAlvoCasa = telemetriaRadar.chC;
                        estadoDoJogo.chutesNoAlvoFora = telemetriaRadar.chF;
                        estadoDoJogo.chutesParaForaCasa = telemetriaRadar.chForaC;
                        estadoDoJogo.chutesParaForaFora = telemetriaRadar.chForaF;
                        estadoDoJogo.posseBolaCasa = telemetriaRadar.posseC;
                        estadoDoJogo.posseBolaFora = telemetriaRadar.posseF;
                    }

                    renderizarPainelTerminal(true);
                    processarMotorDeRegras();
                    registrarTelemetriaContinua(); 

                } catch (err) {
                    // Previne quebras do loop
                }
            }, 5000);
        });
    }

    process.stdin.resume();

    process.stdin.on('keypress', (str, key) => {
        if (key.ctrl && key.name === 'c') process.exit();
        if (key.name === 'space') {
            abrirPromptUrl();
        }
    });
}

iniciarRobo().catch(err => console.error('Erro crítico no motor de dados:', err));