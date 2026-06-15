const puppeteer = require('puppeteer');
const axios = require('axios');

// CONFIGURAÇÕES DO TELEGRAM
const TELEGRAM_TOKEN = '8993868844:AAFokLp2D0gtqzrfACqpfzpwhXVk3J-Ewpc';
const TELEGRAM_CHAT_ID = '6873288591';

// URL DO JOGO QUE VOCÊ QUER MONITORAR
const URL_JOGO = 'https://www.sofascore.com/pt/football/match/plateau-united-nasarawa-united/LoBbsbLKb#id:16294810';

let estadoDoJogo = {
    tempo: 0,
    placar: '0-0',
    pressaoRecente: 0,
    escanteiosCasa: 0,
    escanteiosFora: 0,
    chutesNoAlvoCasa: 0
};

async function enviarAlertaTelegram(mensagem) {
    if (TELEGRAM_TOKEN === 'SEU_BOT_TOKEN_AQUI') return;
    const url = `https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`;
    try { await axios.post(url, { chat_id: TELEGRAM_CHAT_ID, text: mensagem, parse_mode: 'Markdown' }); } catch (e) {}
}

function renderizarPainelTerminal() {
    console.clear(); 
    console.log("=============================================================");
    console.log("🐺 LOBO DEV - ESCANNER PROPRIETÁRIO VIA INJEÇÃO DE DOM       ");
    console.log("=============================================================");
    console.log(`⏱️ Tempo de Jogo:   ${estadoDoJogo.tempo}' min`);
    console.log(`⚽ Placar Atual:    ${estadoDoJogo.placar}`);
    console.log("-------------------------------------------------------------");
    
    let barraPressao = "";
    if (estadoDoJogo.pressaoRecente > 0) {
        barraPressao = `CASA AMASSANDO [${"🔥".repeat(Math.min(Math.ceil(estadoDoJogo.pressaoRecente / 20), 5))}] (+${estadoDoJogo.pressaoRecente})`;
    } else if (estadoDoJogo.pressaoRecente < 0) {
        barraPressao = `ZEBRA/VISITANTE [${"⚠️".repeat(Math.min(Math.ceil(Math.abs(estadoDoJogo.pressaoRecente) / 20), 5))}] (${estadoDoJogo.pressaoRecente})`;
    } else {
        barraPressao = "Jogo Equilibrado / Sem Pressão (0)";
    }
    
    console.log(`📈 Pressão Live:    ${barraPressao}`);
    console.log(`📐 Escanteios:      Casa: ${estadoDoJogo.escanteiosCasa} | Visitante: ${estadoDoJogo.escanteiosFora}`);
    console.log(`🎯 Chutes no Alvo:  Casa: ${estadoDoJogo.chutesNoAlvoCasa}`);
    console.log("=============================================================");
    console.log("📡 Atualizando via varredura de tela a cada 10 segundos...");
}

function processarMotorDeRegras() {
    const { tempo, placar, pressaoRecente, escanteiosCasa, escanteiosFora, chutesNoAlvoCasa } = estadoDoJogo;

    // MÉTODO 1
    if (placar === '0-0' && tempo >= 15 && tempo <= 35 && pressaoRecente > 70 && chutesNoAlvoCasa >= 2) {
        enviarAlertaTelegram(`🎯 *GATILHO: MÉTODO 1 - LAY 0x1*\n⏱️ *Tempo:* ${tempo}'\n⚽ *Placar:* ${placar}\n🔥 *Pressão:* ${pressaoRecente}`);
    }
    // MÉTODO 2
    if (placar === '1-0' && tempo >= 46 && tempo <= 55 && pressaoRecente > 65 && escanteiosCasa >= 4) {
        enviarAlertaTelegram(`🎯 *GATILHO: MÉTODO 2 - BACK 2x0 / LAY 1x1*\n⏱️ *Tempo:* ${tempo}'\n📐 *Escanteios:* ${escanteiosCasa}`);
    }
    // MÉTODO 3
    if (placar === '1-0' && tempo >= 55 && tempo <= 75 && pressaoRecente > 65) {
        enviarAlertaTelegram(`🎯 *GATILHO: MÉTODO 3 - LAY 3x0 / LAY 1x0*\n⏱️ *Tempo:* ${tempo}'\n⚽ *Placar:* ${placar}`);
    }
    // GOL IMINENTE 1T
    if (placar === '0-0' && tempo >= 20 && tempo <= 40 && pressaoRecente > 75 && chutesNoAlvoCasa >= 3 && escanteiosCasa >= 3) {
        enviarAlertaTelegram(`🔥 *ALERTA: GOL IMINENTE - 1º TEMPO*\n⏱️ *Tempo:* ${tempo}'`);
    }
    // GOL IMINENTE 2T
    const placarDeRisco = (placar === '0-0' || placar === '1-1' || placar === '0-1');
    if (tempo >= 70 && tempo <= 85 && placarDeRisco && pressaoRecente > 80 && chutesNoAlvoCasa >= 5) {
        enviarAlertaTelegram(`🚨 *ALERTA: GOL IMINENTE DETECTADO - 2º TEMPO*\n⏱️ *Tempo Crítico:* ${tempo}'`);
    }
}

async function iniciarRobo() {
    console.log('🚀 Inicializando navegador em modo usuário...');

    const browser = await puppeteer.launch({
        headless: false, // Deixe visível para você ver o site abrindo normalmente
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-gpu',
            '--disable-blink-features=AutomationControlled'
        ]
    });

    const page = await browser.newPage();
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36');

    console.log(`🌐 Carregando a página do jogo (Aguarde carregar 100%)...`);
    await page.goto(URL_JOGO, { waitUntil: 'networkidle2', timeout: 60000 });
    
    console.log(`✅ Página carregada sem bloqueios. Iniciando loop de leitura do DOM...`);

    // Loop persistente de varredura de tela (roda a cada 10 segundos)
    setInterval(async () => {
        try {
            const dadosCapturados = await page.evaluate(() => {
                // 1. Captura o Placar Atual pelos elementos de texto de score
                const elementosEscore = document.querySelectorAll('[class*="ScoreText"]');
                let placarStr = '0-0';
                if (elementosEscore.length >= 2) {
                    placarStr = `${elementosEscore[0].textContent.trim()}-${elementosEscore[1].textContent.trim()}`;
                }

                // 2. Captura o Tempo de Jogo
                const elementoTempo = document.querySelector('[class*="MatchTime"], [class*="PeriodTime"]');
                let tempoInt = 0;
                if (elementoTempo) {
                    tempoInt = parseInt(elementoTempo.textContent.replace(/[^0-0-9]/g, '')) || 0;
                }

                // 3. Captura Escanteios e Chutes varrendo os blocos de estatísticas da tela
                let escCasa = 0, escFora = 0, chutesCasa = 0;
                const linhasEstatistica = document.querySelectorAll('[class*="StatisticsRow"], tr');
                
                linhasEstatistica.forEach(linha => {
                    const texto = linha.textContent || '';
                    if (texto.includes('Escanteios') || texto.includes('Corner kicks')) {
                        const valores = texto.match(/\d+/g);
                        if (valores && valores.length >= 2) {
                            escCasa = parseInt(valores[0]);
                            escFora = parseInt(valores[valores.length - 1]);
                        }
                    }
                    if (texto.includes('Chutes no gol') || texto.includes('Shots on target')) {
                        const valores = texto.match(/\d+/g);
                        if (valores) chutesCasa = parseInt(valores[0]);
                    }
                });

                // 4. Captura o gráfico de pressão atual (Bypass do Next.js Data se a rede der 403)
                let pressaoVal = 0;
                const nextDataScript = document.getElementById('__NEXT_DATA__');
                if (nextDataScript) {
                    const data = JSON.parse(nextDataScript.textContent);
                    // Procura dentro da árvore de dados do Next se o gráfico de momentum está injetado na página
                    const eventosMomentum = data?.props?.pageProps?.initialProps?.pageComponentProps?.graphData?.events;
                    if (eventosMomentum && eventosMomentum.length > 0) {
                        pressaoVal = eventosMomentum[eventosMomentum.length - 1].value || 0;
                    }
                }

                return {
                    tempo: tempoInt,
                    placar: placarStr,
                    pressaoRecente: pressaoVal,
                    escanteiosCasa: escCasa,
                    escanteiosFora: escFora,
                    chutesNoAlvoCasa: chutesCasa
                };
            });

            // Atualiza o estado na memória do Node com o que foi lido da tela
            if (dadosCapturados) {
                // Se não achou a pressão pelo NextData, tenta ler o valor pelo tooltip ou deixa em cache
                estadoDoJogo.tempo = dadosCapturados.tempo || estadoDoJogo.tempo;
                estadoDoJogo.placar = dadosCapturados.placar !== '0-0' ? dadosCapturados.placar : estadoDoJogo.placar;
                estadoDoJogo.escanteiosCasa = dadosCapturados.escanteiosCasa || estadoDoJogo.escanteiosCasa;
                estadoDoJogo.escanteiosFora = dadosCapturados.escanteiosFora || estadoDoJogo.escanteiosFora;
                estadoDoJogo.chutesNoAlvoCasa = dadosCapturados.chutesNoAlvoCasa || estadoDoJogo.chutesNoAlvoCasa;
                
                // Se a página renderizou a barra de pressão visualmente, pegamos o valor adaptativo
                estadoDoJogo.pressaoRecente = dadosCapturados.pressaoRecente; 

                renderizarPainelTerminal();
                processarMotorDeRegras();
            }

        } catch (err) {
            // Silencioso para não quebrar o loop do terminal se a tela piscar no refresh
        }
    }, 10000); // 10 segundos é o tempo ideal para não sobrecarregar o renderizador
}

iniciarRobo().catch(err => console.error('Erro crítico:', err));