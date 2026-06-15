// robo-betfair.js
const puppeteer = require('puppeteer');
const readline = require('readline');
const path = require('path');

// Injeção dos componentes modulares do sistema Lobo Dev
const engine = require('./engine_quant');
const logger = require('./logger');

const poolDeJogos = new Map();
const alertasDisparadosPorJogo = new Map();

readline.emitKeypressEvents(process.stdin);
if (process.stdin.isTTY) {
    process.stdin.setRawMode(true);
}

function renderizarPainelTerminal() {
    console.clear();
    console.log("====================================================================");
    console.log("🐺 LOBO DEV - ENGINE QUANT MULTI-JOGOS (ARQUITETURA COMPONENTIZADA)");
    console.log("====================================================================");
    
    if (poolDeJogos.size === 0) {
        console.log("\n 🔍 Nenhum jogo ativo no Pool. Pressione ESPAÇO para adicionar...\n");
        console.log("====================================================================");
        return;
    }

    for (let [id, jogo] of poolDeJogos.entries()) {
        const xgMax = Math.max(jogo.xgCasa, jogo.xgFora);
        let statusLinha = "Escaneando...";
        
        if (jogo.noIntervalo) {
            statusLinha = "⏸️ INTERVALO";
        } else {
            const alertas = alertasDisparadosPorJogo.get(id);
            if (alertas && alertas.golIminente2T) statusLinha = "🚨 GATILHO 2T!";
            else if (alertas && alertas.golIminente1T) statusLinha = "🔥 GATILHO 1T!";
        }

        console.log(`🏟️ Partida:  ${jogo.nomePartida.padEnd(55)}`);
        console.log(`⏱️ Min: ${String(jogo.tempo).padStart(2)}' | Placar: ${jogo.placar.padEnd(5)} | Pressão Max: ${jogo.pressao.toFixed(2)} AP/Min | xG Max: ${xgMax.toFixed(2)}`);
        console.log(`🔬 Micro10m: APM:(${jogo.momentum.ataquesCasa}/${jogo.momentum.ataquesFora}) Chutes:(${jogo.momentum.chutesNoAlvoCasa}/${jogo.momentum.chutesNoAlvoFora}) Esc:(${jogo.momentum.escanteiosCasa}/${jogo.momentum.escanteiosFora})`);
        console.log(`⚡ Status:    ${statusLinha}`);
        console.log("--------------------------------------------------------------------");
    }
    console.log("[Espaço] Adicionar Novo Jogo | [Ctrl+C] Encerrar Sistema");
    console.log("====================================================================");
}

async function iniciarRobo() {
    const browser = await puppeteer.launch({
        headless: false,
        defaultViewport: null,
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-gpu']
    });

    console.log(`\n🤖 ENGINE DE TELEMETRIA MODULAR PRONTA!`);

    // Loop Mestre assíncrono recursivo (A cada 5 segundos)
    setInterval(async () => {
        if (poolDeJogos.size === 0) return;

        for (let [idJogo, jogo] of poolDeJogos.entries()) {
            try {
                // Raspagem isolada do contexto da página para capturar os nomes das equipas
                const dadosContexto = await jogo.pageContext.evaluate(() => {
                    let info = { timeCasa: '', timeFora: '', tituloAba: document.title };
                    let rootDiv = document.querySelector('[wire\\:snapshot]');
                    if (rootDiv) {
                        try {
                            let snapshot = JSON.parse(rootDiv.getAttribute('wire:snapshot'));
                            if (snapshot && snapshot.data) {
                                info.timeCasa = snapshot.data.timeCasa; info.timeFora = snapshot.data.timeFora;
                            }
                        } catch (e) {}
                    }
                    return info;
                });

                if (dadosContexto.timeCasa && dadosContexto.timeFora) {
                    jogo.nomePartida = `${dadosContexto.timeCasa} v ${dadosContexto.timeFora}`;
                } else if (dadosContexto.tituloAba) {
                    jogo.nomePartida = dadosContexto.tituloAba.split('|')[0].trim();
                }

                const todosOsFrames = await jogo.pageContext.frames();
                let frameRadar = todosOsFrames.find(f => 
                    f.url().includes('radarfutebol.xyz/scoreboards') || 
                    f.name() === 'iframe-williamhill'
                );

                let contextoAlvo = frameRadar ? frameRadar : jogo.pageContext;

                // Extração baseada nos seletores estruturais estáveis
                const r = await contextoAlvo.evaluate(() => {
                    let tempoLocal = 0; let placarLocal = ''; let statusIntervalo = false; let statusEncerrado = false;
                    let atqC = 0, atqF = 0, escC = 0, escF = 0, chC = 0, chF = 0, chForaC = 0, chForaF = 0, posseC = 50, posseF = 50;
                    
                    let spanRelogio = document.querySelector('[data-push="clock"], .clockWrapper span');
                    if (spanRelogio && spanRelogio.textContent) {
                        let textoCru = spanRelogio.textContent.trim().toLowerCase();
                        
                        // Detecção estrutural de fim de partida (Full Time / Terminado)
                        if (textoCru.includes('fim') || textoCru.includes('ft') || textoCru.includes('encerrado') || textoCru.includes('terminado')) {
                            statusEncerrado = true;
                        } else if (textoCru.includes('intervalo') || textoCru.includes('ht') || textoCru.includes('int')) {
                            statusIntervalo = true; tempoLocal = 45; 
                        } else {
                            let matchHora = textoCru.match(/(\d{1,2}):(\d{2})/);
                            if (matchHora) {
                                let m = parseInt(matchHora[1]) || 0; let s = parseInt(matchHora[2]) || 0;
                                tempoLocal = s > 0 ? m + 1 : m;
                            }
                        }
                    }

                    let nósTexto = Array.from(document.querySelectorAll('div, span, p, b')).map(el => el.textContent ? el.textContent.trim() : '');
                    let matchPlacar = nósTexto.find(t => /^\d+\s*-\s*\d+$/.test(t));
                    if (matchPlacar) placarLocal = matchPlacar.replace(/\s+/g, '');

                    let wrapper = document.getElementById('stats_wrapper');
                    if (wrapper) {
                        let blocoAtq = wrapper.querySelector('[data-stat="dangerousAttacks"]');
                        if (blocoAtq) { atqC = parseInt(blocoAtq.querySelector('.home')?.textContent || '0') || 0; atqF = parseInt(blocoAtq.querySelector('.away')?.textContent || '0') || 0; }
                        
                        let blocoEsc = wrapper.querySelector('[data-stat="corners"]');
                        if (blocoEsc) { escC = parseInt(blocoEsc.querySelector('.home')?.textContent || '0') || 0; escF = parseInt(blocoEsc.querySelector('.away')?.textContent || '0') || 0; }
                        
                        let blocoChutes = wrapper.querySelector('[data-stat="shotsOnTarget"]');
                        if (blocoChutes) { chC = parseInt(blocoChutes.querySelector('.home')?.textContent || '0') || 0; chF = parseInt(blocoChutes.querySelector('.away')?.textContent || '0') || 0; }
                        
                        let blocoFora = wrapper.querySelector('[data-stat="statsOffTarget"], [data-stat="shotsOffTarget"]');
                        if (blocoFora) { chForaC = parseInt(blocoFora.querySelector('.home')?.textContent || '0') || 0; chForaF = parseInt(blocoFora.querySelector('.away')?.textContent || '0') || 0; }

                        let blocoPosse = wrapper.querySelector('[data-stat="possession"], [data-stat="BallPossession"]');
                        if (blocoPosse) {
                            posseC = parseInt(blocoPosse.querySelector('.home')?.textContent?.replace(/[^0-9]/g, '')) || 50;
                            posseF = parseInt(blocoPosse.querySelector('.away')?.textContent?.replace(/[^0-9]/g, '')) || 50;
                        }
                    }
                    return { tempoLocal, placarLocal, statusIntervalo, statusEncerrado, atqC, atqF, escC, escF, chC, chF, chForaC, chForaF, posseC, posseF };
                });

             if (r) {
                    // 🛑 ROTINA DE EXCLUSÃO AUTOMÁTICA POR TÉRMINO DE PARTIDA (Garbage Collection)
                    if (r.statusEncerrado) {
                        try {
                            await jogo.pageContext.close(); // Destrói a aba do Chromium para aliviar CPU/RAM
                        } catch (e) {}
                        
                        poolDeJogos.delete(idJogo);
                        alertasDisparadosPorJogo.delete(idJogo);
                        
                        // Atualiza o painel web imediatamente para remover o card da tela em real-time
                        logger.atualizarDadosPainelWeb(poolDeJogos, alertasDisparadosPorJogo);
                        continue; 
                    }

                    // 🎯 GERENCIAMENTO DE ESTADO DO INTERVALO
                    jogo.noIntervalo = r.statusIntervalo;

                    // Se estiver no intervalo, apenas pula o cálculo de deltas, mantendo o histórico intacto
                    if (r.statusIntervalo) { 
                        if (r.tempoLocal > 0 && r.tempoLocal >= jogo.tempo) jogo.tempo = r.tempoLocal;
                        if (r.placarLocal && r.placarLocal.includes('-')) jogo.placar = r.placarLocal;
                        continue; 
                    }

                    if (r.tempoLocal > 0 && r.tempoLocal >= jogo.tempo) jogo.tempo = r.tempoLocal;
                    if (r.placarLocal && r.placarLocal.includes('-')) jogo.placar = r.placarLocal;

                    let minAtual = jogo.tempo;

                    // 🛡️ TRAVA CORE: Sincronização inicial do feed (SÓ RODA SE OS DADOS DA MEMÓRIA ESTIVEREM ZERADOS)
                    if (!jogo.sincronizadoComFeed) {
                        jogo.ataquesPerigososCasa = r.atqC; jogo.ataquesPerigososFora = r.atqF;
                        jogo.escanteiosCasa = r.escC; jogo.escanteiosFora = r.escF;
                        jogo.chutesNoAlvoCasa = r.chC; jogo.chutesNoAlvoFora = r.chF;
                        jogo.chutesParaForaCasa = r.chForaC; jogo.chutesParaForaFora = r.chForaF;
                        jogo.posseBolaCasa = r.posseC; jogo.posseBolaFora = r.posseF;
                        jogo.sincronizadoComFeed = true; 
                        continue;
                    }

                    // 🛠️ TRAVA DE SANIDADE QUANT: Filtra picos falsos causados por lag do DOM ou reinício de HT/2T
                    
                    // CASO ESPECIAL: Se o segundo tempo começou e o radar zerou os contadores dele no site,
                    // nós sincronizamos os novos valores baixos sem gerar deltas fantasmas no histórico.
                    if (r.atqC < jogo.ataquesPerigososCasa && minAtual > 45) {
                        jogo.ataquesPerigososCasa = r.atqC;
                        jogo.ataquesPerigososFora = r.atqF;
                        jogo.escanteiosCasa = r.escC;
                        jogo.escanteiosFora = r.escF;
                        jogo.chutesNoAlvoCasa = r.chC;
                        jogo.chutesNoAlvoFora = r.chF;
                        jogo.chutesParaForaCasa = r.chForaC;
                        jogo.chutesParaForaFora = r.chForaF;
                    } else {
                        // Fluxo Normal de Acréscimo de Deltas (A tua lógica estável original)
                        if (r.atqC > jogo.ataquesPerigososCasa) {
                            let delta = r.atqC - jogo.ataquesPerigososCasa;
                            if (delta <= 4) { for (let i = 0; i < delta; i++) jogo.historicoAtqCasa.push(minAtual); }
                        }
                        if (r.atqF > jogo.ataquesPerigososFora) {
                            let delta = r.atqF - jogo.ataquesPerigososFora;
                            if (delta <= 4) { for (let i = 0; i < delta; i++) jogo.historicoAtqFora.push(minAtual); }
                        }
                        if (r.escC > jogo.escanteiosCasa) {
                            let delta = r.escC - jogo.escanteiosCasa;
                            if (delta <= 2) { for (let i = 0; i < delta; i++) jogo.historicoEscCasa.push(minAtual); }
                        }
                        if (r.escF > jogo.escanteiosFora) {
                            let delta = r.escF - jogo.escanteiosFora;
                            if (delta <= 2) { for (let i = 0; i < delta; i++) jogo.historicoEscFora.push(minAtual); }
                        }
                        if (r.chC > jogo.chutesNoAlvoCasa) {
                            let delta = r.chC - jogo.chutesNoAlvoCasa;
                            if (delta <= 2) { for (let i = 0; i < delta; i++) jogo.historicoChAlvoCasa.push(minAtual); }
                        }
                        if (r.chF > jogo.chutesNoAlvoFora) {
                            let delta = r.chF - jogo.chutesNoAlvoFora;
                            if (delta <= 2) { for (let i = 0; i < delta; i++) jogo.historicoChAlvoFora.push(minAtual); }
                        }
                        if (r.chForaC > jogo.chutesParaForaCasa) {
                            let delta = r.chForaC - jogo.chutesParaForaCasa;
                            if (delta <= 2) { for (let i = 0; i < delta; i++) jogo.historicoChForaCasa.push(minAtual); }
                        }
                        if (r.chForaF > jogo.chutesParaForaFora) {
                            let delta = r.chForaF - jogo.chutesParaForaFora;
                            if (delta <= 2) { for (let i = 0; i < delta; i++) jogo.historicoChForaFora.push(minAtual); }
                        }

                        // Grava os absolutos estáveis na memória RAM do processo
                        jogo.ataquesPerigososCasa = r.atqC;
                        jogo.ataquesPerigososFora = r.atqF;
                        jogo.escanteiosCasa = r.escC;
                        jogo.escanteiosFora = r.escF;
                        jogo.chutesNoAlvoCasa = r.chC;
                        jogo.chutesNoAlvoFora = r.chF;
                        jogo.chutesParaForaCasa = r.chForaC;
                        jogo.chutesParaForaFora = r.chForaF;
                    }

                    if (r.posseC > 0) { jogo.posseBolaCasa = r.posseC; jogo.posseBolaFora = r.posseF; }
                    
                    if (r.atqF > jogo.ataquesPerigososFora) {
                        let delta = r.atqF - jogo.ataquesPerigososFora;
                        if (delta <= 4) { for (let i = 0; i < delta; i++) jogo.historicoAtqFora.push(minAtual); }
                    }
                    if (r.escC > jogo.escanteiosCasa) {
                        let delta = r.escC - jogo.escanteiosCasa;
                        if (delta <= 2) { for (let i = 0; i < delta; i++) jogo.historicoEscCasa.push(minAtual); }
                    }
                    if (r.escF > jogo.escanteiosFora) {
                        let delta = r.escF - jogo.escanteiosFora;
                        if (delta <= 2) { for (let i = 0; i < delta; i++) jogo.historicoEscFora.push(minAtual); }
                    }
                    if (r.chC > jogo.chutesNoAlvoCasa) {
                        let delta = r.chC - jogo.chutesNoAlvoCasa;
                        if (delta <= 2) { for (let i = 0; i < delta; i++) jogo.historicoChAlvoCasa.push(minAtual); }
                    }
                    if (r.chF > jogo.chutesNoAlvoFora) {
                        let delta = r.chF - jogo.chutesNoAlvoFora;
                        if (delta <= 2) { for (let i = 0; i < delta; i++) jogo.historicoChAlvoFora.push(minAtual); }
                    }
                    if (r.chForaC > jogo.chutesParaForaCasa) {
                        let delta = r.chForaC - jogo.chutesParaForaCasa;
                        if (delta <= 2) { for (let i = 0; i < delta; i++) jogo.historicoChForaCasa.push(minAtual); }
                    }
                    if (r.chForaF > jogo.chutesParaForaFora) {
                        let delta = r.chForaF - jogo.chutesParaForaFora;
                        if (delta <= 2) { for (let i = 0; i < delta; i++) jogo.historicoChForaFora.push(minAtual); }
                    }

                    // Protege os absolutos contra quedas falsas do DOM no início do 2º Tempo
                    if (r.atqC >= jogo.ataquesPerigososCasa) jogo.ataquesPerigososCasa = r.atqC;
                    if (r.atqF >= jogo.ataquesPerigososFora) jogo.ataquesPerigososFora = r.atqF;
                    if (r.escC >= jogo.escanteiosCasa) jogo.escanteiosCasa = r.escC;
                    if (r.escF >= jogo.escanteiosFora) jogo.escanteiosFora = r.escF;
                    if (r.chC >= jogo.chutesNoAlvoCasa) jogo.chutesNoAlvoCasa = r.chC;
                    if (r.chF >= jogo.chutesNoAlvoFora) widget = jogo.chutesNoAlvoFora = r.chF;
                    if (r.chForaC >= jogo.chutesParaForaCasa) jogo.chutesParaForaCasa = r.chForaC;
                    if (r.chForaF >= jogo.chutesParaForaFora) jogo.chutesParaForaFora = r.chForaF;
                    if (r.posseC > 0) { jogo.posseBolaCasa = r.posseC; jogo.posseBolaFora = r.posseF; }
                }

                // Invoca as validações do Motor Matemático e escrita em disco local
                engine.processarMotorDeRegras(idJogo, jogo, alertasDisparadosPorJogo.get(idJogo));
                logger.registrarTelemetriaContinua(jogo);

            } catch (err) {}
        }

        // Transmite o estado unificado para a rede (Painel HTML via streaming SSE)
        logger.atualizarDadosPainelWeb(poolDeJogos, alertasDisparadosPorJogo);

        renderizarPainelTerminal();
    }, 5000);

    function abrirPromptNovaAba() {
        if (process.stdin.isTTY) process.stdin.setRawMode(false);
        process.stdin.pause();
        const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
        console.log("\n--------------------------------------------------------------------");
        rl.question('🔗 Cole a URL do jogo do RadarFutebol para adicionar ao Pool: ', async (urlDigitada) => {
            rl.close();
            if (process.stdin.isTTY) process.stdin.setRawMode(true);
            process.stdin.resume();

            const urlValida = urlDigitada.trim();
            if (!urlValida.startsWith('http')) return;

            const idJogo_unico = String(urlValida.split('/').pop() || Date.now());
            if (poolDeJogos.has(idJogo_unico)) return;

            try {
                const novaAba = await browser.newPage();
                await novaAba.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36');
                await novaAba.goto(urlValida, { waitUntil: 'domcontentloaded' });

                poolDeJogos.set(idJogo_unico, {
                    pageContext: novaAba, nomePartida: 'Carregando...', tempo: 0, placar: '0-0', noIntervalo: false, sincronizadoComFeed: false, momentumResetado2T: false,
                    ataquesPerigososCasa: 0, ataquesPerigososFora: 0, escanteiosCasa: 0, escanteiosFora: 0, chutesNoAlvoCasa: 0, chutesNoAlvoFora: 0, chutesParaForaCasa: 0, chutesParaForaFora: 0, posseBolaCasa: 50, posseBolaFora: 50, pressao: 0.00, xgCasa: 0.00, xgFora: 0.00,
                    momentum: { ataquesCasa: 0, ataquesFora: 0, escanteiosCasa: 0, escanteiosFora: 0, chutesNoAlvoCasa: 0, chutesNoAlvoFora: 0, chutesParaForaCasa: 0, chutesParaForaFora: 0 },
                    historicoAtqCasa: [], historicoAtqFora: [], historicoEscCasa: [], historicoEscFora: [], historicoChAlvoCasa: [], historicoChAlvoFora: [], historicoChForaCasa: [], historicoChForaFora: []
                });
                alertasDisparadosPorJogo.set(idJogo_unico, { metodo1: false, metodo2: false, golIminente1T: false, golIminente2T: false });
            } catch (err) {}
        });
    }

    process.stdin.resume();
    process.stdin.on('keypress', (str, key) => {
        if (key.ctrl && key.name === 'c') process.exit();
        if (key.name === 'space') abrirPromptNovaAba();
    });
}

iniciarRobo().catch(err => console.error(err));