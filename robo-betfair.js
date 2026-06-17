// robo-betfair.js
const puppeteer = require('puppeteer');
const readline  = require('readline');
const path      = require('path');

// Injeção dos componentes modulares do sistema Lobo Dev
const engine   = require('./engine_quant');
const logger   = require('./logger');
const betfair  = require('./betfair');

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
        // CORREÇÃO: Identifica quem realmente está exercendo a maior pressão isolada no momento (janela 5m)
        const apmCasa = jogo.historicoAtqCasa.length > 0 ? (jogo.pressao - (jogo.historicoAtqFora.length / 5)) : 0; // Fallback seguro baseado no cálculo da engine
        // Para simplificar e buscar direto as variáveis calculadas de forma limpa:
        const apmMaxAtual = Math.max(jogo.pressao - (jogo.historicoAtqFora.length / 5 || 0), jogo.pressao - (jogo.historicoAtqCasa.length / 5 || 0));

        let statusLinha = "Escaneando...";

        if (jogo.noIntervalo) {
            statusLinha = "⏸️ INTERVALO";
        } else {
            const alertas = alertasDisparadosPorJogo.get(id);
            if (alertas && alertas.golIminente2T)          statusLinha = "🚨 GATILHO 2T!";
            else if (alertas && alertas.golIminente2TFora) statusLinha = "🚨 GATILHO 2T FORA";
            else if (alertas && alertas.favoritoVira)      statusLinha = "🔄 FAVORITO VIRA";
            else if (alertas && alertas.favoritoVence)     statusLinha = "💰 FAVORITO VENCE";
            else if (alertas && alertas.golIminente1T)     statusLinha = "🔥 GATILHO 1T!";
            else if (alertas && alertas.golIminente1TFora) statusLinha = "🔥 GATILHO 1T FORA";
            else if (alertas && alertas.layDraw)           statusLinha = "🏆 LAY DRAW";
            else if (alertas && alertas.lay11)             statusLinha = "🎯 LAY 1x1";
            else if (alertas && alertas.lay01)             statusLinha = "⚡ LAY 0x1";
            else if (alertas && alertas.lay10)             statusLinha = "⚡ LAY 1x0";
            else if (alertas && alertas.lay12)             statusLinha = "⚡ LAY 1x2";
            else if (alertas && alertas.lay21)             statusLinha = "⚡ LAY 2x1";
            else if (alertas && alertas.lay00)             statusLinha = "🔵 LAY 0x0";
        }

        console.log(`🏟️ Partida:  ${jogo.nomePartida.padEnd(55)}`);
        // CORREÇÃO VISUAL: Agora exibe o xG real de cada lado detalhado e a Pressão Coletiva combinada
        console.log(`⏱️ Min: ${String(jogo.tempo).padStart(2)}' | Placar: ${jogo.placar.padEnd(5)} | Pressão Total: ${jogo.pressao.toFixed(2)} APM | xG: C:${jogo.xgCasa.toFixed(2)} - F:${jogo.xgFora.toFixed(2)}`);
        console.log(`🔬 Micro10m: APM:(${jogo.momentum.ataquesCasa}/${jogo.momentum.ataquesFora}) Chutes:(${jogo.momentum.chutesNoAlvoCasa}/${jogo.momentum.chutesNoAlvoFora}) Esc:(${jogo.momentum.escanteiosCasa}/${jogo.momentum.escanteiosFora})`);
        console.log(`⚡ Status:    ${statusLinha}`);
        console.log("--------------------------------------------------------------------");
    }
    console.log("[Espaço] Adicionar Novo Jogo | [Ctrl+C] Encerrar Sistema");
    console.log("====================================================================");
}

async function iniciarRobo() {
    const browser = await puppeteer.launch({
        headless: true,
        defaultViewport: null,
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-gpu']
    });

    console.log(`\n🤖 ENGINE DE TELEMETRIA MODULAR PRONTA!`);



    // ─── LOOP DEDICADO AO SCREENSHOT (a cada 30s, independente do loop principal) ───
    setInterval(async () => {
        for (let [idJogo, jogo] of poolDeJogos.entries()) {
            try {
                // Seletor específico pelo ID do jogo, depois fallback genérico
                let iframeEl = await jogo.pageContext.$(`#sofascore-momentum-${idJogo}`);
                if (!iframeEl) iframeEl = await jogo.pageContext.$('[id^="sofascore-momentum-"]');

                if (!iframeEl) {
                    const lista = await jogo.pageContext.$$eval('iframe', els =>
                        els.map(e => e.id || e.name || e.src).filter(Boolean)
                    );
                    process.stderr.write(`[MOMENTUM] ⚠️ ${jogo.nomePartida}: iframe não encontrado. IDs na página: ${JSON.stringify(lista)}\n`);
                    continue;
                }

                // Aguarda a página estar estável (sem requests a decorrer)
                await jogo.pageContext.waitForNetworkIdle({ idleTime: 800, timeout: 5000 }).catch(() => {});

                // Scroll até ao elemento e aguarda render completo
                await iframeEl.evaluate(el => el.scrollIntoView({ block: 'nearest' }));
                await new Promise(r => setTimeout(r, 1200));

                const box = await iframeEl.boundingBox();
                if (!box || box.width < 10 || box.height < 10) {
                    process.stderr.write(`[MOMENTUM] ⚠️ ${jogo.nomePartida}: boundingBox inválido ${JSON.stringify(box)}\n`);
                    continue;
                }

                const screenshot = await jogo.pageContext.screenshot({
                    encoding: 'base64',
                    type: 'jpeg',
                    quality: 80,
                    clip: { x: Math.max(0, box.x), y: Math.max(0, box.y), width: box.width, height: box.height }
                });

                if (screenshot) {
                    // 🛡️ GUARDA SÓ SE A IMAGEM TEM CONTEÚDO REAL
                    // Uma imagem em branco/vazia tem poucos bytes (~2-4KB base64)
                    // Um gráfico real tem normalmente >8KB
                    const tamanhoKB = screenshot.length / 1024;
                    const imagemAnteriorKB = jogo.sofascoreMomentumImg
                        ? jogo.sofascoreMomentumImg.length / 1024
                        : 0;

                    if (tamanhoKB < 4) {
                        process.stderr.write(`[MOMENTUM] ⚠️ ${jogo.nomePartida}: imagem muito pequena (${tamanhoKB.toFixed(1)}KB) — provável blank, ignorada\n`);
                        continue;
                    }

                    // Só substitui se a nova imagem for maior ou se ainda não há nenhuma
                    if (!jogo.sofascoreMomentumImg || tamanhoKB >= imagemAnteriorKB * 0.6) {
                        const dataUrl = `data:image/jpeg;base64,${screenshot}`;
                        jogo.sofascoreMomentumImg = dataUrl;
                        logger.registrarScreenshotMomentum(idJogo, dataUrl);
                        process.stdout.write(`[MOMENTUM] ✅ ${jogo.nomePartida}: ${tamanhoKB.toFixed(1)}KB\n`);
                    } else {
                        process.stderr.write(`[MOMENTUM] ⚠️ ${jogo.nomePartida}: nova imagem (${tamanhoKB.toFixed(1)}KB) menor que anterior (${imagemAnteriorKB.toFixed(1)}KB) — mantida anterior\n`);
                    }
                }
            } catch (e) {
                process.stderr.write(`[MOMENTUM] ❌ ${jogo.nomePartida}: ${e.message}\n`);
            }
        }
    }, 30000);

    // Registra o callback para que o painel web possa adicionar jogos via POST /add-game
    logger.registrarCallbackAdicionarJogo(async (urlValida) => {
        const idJogo_unico = String(urlValida.split('/').pop() || Date.now());
        if (poolDeJogos.has(idJogo_unico)) return;
        const novaAba = await browser.newPage();
        await novaAba.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36');
        await novaAba.goto(urlValida, { waitUntil: 'domcontentloaded' });
        poolDeJogos.set(idJogo_unico, {
            pageContext: novaAba, nomePartida: 'Carregando...', id: idJogo_unico, tempo: 0, placar: '0-0', noIntervalo: false, sincronizadoComFeed: false, momentumResetado2T: false,
            ultimoTempoRegistrado: 0, ciclosSemMudancaTempo: 0,
            betfairMarketId: null, betfairOdds: null, betfairBuscado: false,
            sofascoreMomentumImg: null, _ultimoScreenshotMomentum: 0,
            ataquesPerigososCasa: 0, ataquesPerigososFora: 0, escanteiosCasa: 0, escanteiosFora: 0, chutesNoAlvoCasa: 0, chutesNoAlvoFora: 0, chutesParaForaCasa: 0, chutesParaForaFora: 0, posseBolaCasa: 50, posseBolaFora: 50, pressao: 0.00, xgCasa: 0.00, xgFora: 0.00,
            momentum: { ataquesCasa: 0, ataquesFora: 0, escanteiosCasa: 0, escanteiosFora: 0, chutesNoAlvoCasa: 0, chutesNoAlvoFora: 0, chutesParaForaCasa: 0, chutesParaForaFora: 0 },
            historicoAtqCasa: [], historicoAtqFora: [], historicoEscCasa: [], historicoEscFora: [], historicoChAlvoCasa: [], historicoChAlvoFora: [], historicoChForaCasa: [], historicoChForaFora: []
        });
        alertasDisparadosPorJogo.set(idJogo_unico, { metodo1: false, metodo2: false, golIminente1T: false, golIminente1TFora: false, golIminente2T: false, golIminente2TFora: false, layDraw: false, lay00: false, lay01: false, lay10: false, lay11: false, lay12: false, lay21: false, favoritoVence: false, favoritoVira: false });
    });

    // Loop Mestre assíncrono recursivo (A cada 5 segundos)
    setInterval(async () => {
        if (poolDeJogos.size === 0) return;

        for (let [idJogo, jogo] of poolDeJogos.entries()) {
            try {
                // Raspagem isolada do contexto da página para capturar os nomes das equipas
                const dadosContexto = await jogo.pageContext.evaluate(() => {
                    let info = { timeCasa: '', timeFora: '', tituloAba: document.title };

                    // Camada 1: wire:snapshot (Livewire — suporta múltiplos campos de nome por região)
                    let rootDiv = document.querySelector('[wire\\:snapshot]');
                    if (rootDiv) {
                        try {
                            let snapshot = JSON.parse(rootDiv.getAttribute('wire:snapshot'));
                            let d = snapshot && snapshot.data;
                            if (d) {
                                info.timeCasa = d.timeCasa || d.homeTeam || d.home_team || d.homeName || d.team_home || '';
                                info.timeFora = d.timeFora || d.awayTeam || d.away_team || d.awayName || d.team_away || '';
                            }
                        } catch (e) {}
                    }

                    // Camada 2: seletores DOM diretos de nome de equipa
                    if (!info.timeCasa || !info.timeFora) {
                        const seletoresCasa = ['.home-team-name', '.home .team-name', '[class*="homeTeam"] [class*="name"]', '[class*="home-team"]', '.participant-name.home', '[data-home-team]'];
                        const seletoresFora = ['.away-team-name', '.away .team-name', '[class*="awayTeam"] [class*="name"]', '[class*="away-team"]', '.participant-name.away', '[data-away-team]'];
                        for (let sel of seletoresCasa) {
                            let el = document.querySelector(sel);
                            if (el && el.textContent.trim()) { info.timeCasa = el.textContent.trim(); break; }
                        }
                        for (let sel of seletoresFora) {
                            let el = document.querySelector(sel);
                            if (el && el.textContent.trim()) { info.timeFora = el.textContent.trim(); break; }
                        }
                    }

                    // Camada 3: meta og:title (ex: "Sportivo Barracas vs General Lamadrid - RadarFutebol")
                    if (!info.timeCasa || !info.timeFora) {
                        let metaOg = document.querySelector('meta[property="og:title"]') || document.querySelector('meta[name="title"]');
                        if (metaOg) info.tituloAba = metaOg.getAttribute('content') || info.tituloAba;
                    }

                    return info;
                });

                if (dadosContexto.timeCasa && dadosContexto.timeFora) {
                    jogo.nomePartida = `${dadosContexto.timeCasa} v ${dadosContexto.timeFora}`;
                } else if (dadosContexto.tituloAba) {
                    // Tenta extrair "Time A vs/v/x Time B" do título
                    let tit = dadosContexto.tituloAba;
                    let match = tit.match(/^(.+?)\s+(?:vs\.?|v|x)\s+(.+?)(?:\s*[-|]|$)/i);
                    if (match) {
                        jogo.nomePartida = `${match[1].trim()} v ${match[2].trim()}`;
                    } else if (tit && !tit.toLowerCase().includes('radar') && !tit.toLowerCase().includes('futebol') && tit.length > 5) {
                        jogo.nomePartida = tit.split('|')[0].trim();
                    }
                    // Se o título é genérico (só nome do site), mantém o fallback do ID abaixo
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
                    
                    // 🔍 CAMADA 1: Seletor expandido para cobrir múltiplas versões do radar
                    let spanRelogio = document.querySelector(
                        '[data-push="clock"], .clockWrapper span, .match-clock, .match-time, ' +
                        '[class*="clock"], [class*="Clock"], [class*="timer"], [class*="Timer"], ' +
                        '.period-time, .live-time, .game-time, [data-testid="match-time"]'
                    );
                    if (spanRelogio && spanRelogio.textContent) {
                        let textoCru = spanRelogio.textContent.trim().toLowerCase();
                        
                        // Detecção estrutural de fim de partida — palavras-chave expandidas
                        if (textoCru.includes('fim') || textoCru.includes('ft') || textoCru.includes('encerrado') ||
                            textoCru.includes('terminado') || textoCru.includes('encerrada') || textoCru.includes('terminada') ||
                            textoCru.includes('full time') || textoCru.includes('fulltime') || textoCru.includes('final') ||
                            textoCru.includes('resultado final') || textoCru.includes('ended') || textoCru.includes('finished') ||
                            textoCru.includes('apito final')) {
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

                    // 🔍 CAMADA 2: Scan por badges/elementos de FT quando o relógio não é encontrado
                    if (!statusEncerrado) {
                        let ftBadge = document.querySelector(
                            '.ft-badge, .status-ft, [class*="fulltime"], [class*="full-time"], ' +
                            '[class*="finished"], [class*="ended"], [class*="status-ended"], ' +
                            '[data-status="FT"], [data-status="ft"], [data-status="finished"]'
                        );
                        if (ftBadge) statusEncerrado = true;
                    }

                    // 🔍 CAMADA 3: Busca textual em elementos de status da página
                    if (!statusEncerrado) {
                        let statusEl = document.querySelector('.match-status, .game-status, .status-label, [class*="matchStatus"], [class*="gameStatus"]');
                        if (statusEl) {
                            let st = statusEl.textContent.trim().toLowerCase();
                            if (st.includes('ft') || st.includes('fim') || st.includes('terminado') || st.includes('encerrado') || st.includes('final') || st.includes('finished') || st.includes('ended')) {
                                statusEncerrado = true;
                            }
                        }
                    }

                    let nósTexto = Array.from(document.querySelectorAll('div, span, p, b')).map(el => el.textContent ? el.textContent.trim() : '');
                    let matchPlacar = nósTexto.find(t => /^\d+\s*-\s*\d+$/.test(t));
                    if (matchPlacar) placarLocal = matchPlacar.replace(/\s+/g, '');

                    // Captura o src do iframe do gráfico Sofascore Momentum
                    let momentumSrc = '';
                    const iframeMomentum = document.querySelector('[id^="sofascore-momentum-"]');
                    if (iframeMomentum) {
                        momentumSrc = iframeMomentum.src || iframeMomentum.getAttribute('src') || '';
                    }

                    let wrapper = document.getElementById('stats_wrapper');
                    if (wrapper) {
                        // Seletor expandido: cobre variações de nome usadas por diferentes ligas/feeds do radar
                        let blocoAtq = wrapper.querySelector(
                            '[data-stat="dangerousAttacks"], [data-stat="dangerous_attacks"], ' +
                            '[data-stat="dangerousattacks"], [data-stat="DangerousAttacks"], ' +
                            '[data-stat="attacks"], [data-stat="Attacks"]'
                        );
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
                    return { tempoLocal, placarLocal, statusIntervalo, statusEncerrado, atqC, atqF, escC, escF, chC, chF, chForaC, chForaF, posseC, posseF, momentumSrc };
                });

             if (r) {
                    // 🔍 CAMADA 4 (Node.js): Encerramento por estagnação de tempo ≥ 90min sem mudança (~30s)
                    if (!r.statusEncerrado && r.tempoLocal >= 90 && !r.statusIntervalo) {
                        if (r.tempoLocal === jogo.ultimoTempoRegistrado) {
                            jogo.ciclosSemMudancaTempo = (jogo.ciclosSemMudancaTempo || 0) + 1;
                            if (jogo.ciclosSemMudancaTempo >= 6) {
                                r.statusEncerrado = true;
                            }
                        } else {
                            jogo.ciclosSemMudancaTempo = 0;
                        }
                    }
                    jogo.ultimoTempoRegistrado = r.tempoLocal;

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
                    if (r.momentumSrc) jogo.sofascoreMomentumUrl = r.momentumSrc;
                }

                // Invoca as validações do Motor Matemático e escrita em disco local
                engine.processarMotorDeRegras(idJogo, jogo, alertasDisparadosPorJogo.get(idJogo));
                logger.registrarTelemetriaContinua(jogo);

                // 🎰 ODDS API: Chamada ÚNICA por jogo
                // Usada pelos métodos FAVORITO VENCE e FAVORITO VIRA para identificar
                // qual equipa o mercado considera favorita. Não atualiza durante o jogo.
                if (!jogo.betfairBuscado && jogo.nomePartida && !jogo.nomePartida.includes('Carregando')) {
                    jogo.betfairBuscado = true;
                    const nomeCasa = jogo.nomePartida.split(' v ')[0]?.trim() || '';
                    const nomeFora = jogo.nomePartida.split(' v ')[1]?.trim() || '';
                    betfair.buscarMercadoPartida(nomeCasa, nomeFora).then(async mercado => {
                        if (mercado) {
                            jogo.betfairMarketId = mercado;
                            const odds = await betfair.buscarOddsAtuais(mercado);
                            if (odds) jogo.betfairOdds = odds; // Guardado 1 vez, nunca mais atualizado
                        }
                    }).catch(() => {});
                }

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
                    pageContext: novaAba, nomePartida: 'Carregando...', id: idJogo_unico, tempo: 0, placar: '0-0', noIntervalo: false, sincronizadoComFeed: false, momentumResetado2T: false,
                    ultimoTempoRegistrado: 0, ciclosSemMudancaTempo: 0,
                    betfairMarketId: null, betfairOdds: null, betfairBuscado: false,
                    sofascoreMomentumImg: null, _ultimoScreenshotMomentum: 0,
                    ataquesPerigososCasa: 0, ataquesPerigososFora: 0, escanteiosCasa: 0, escanteiosFora: 0, chutesNoAlvoCasa: 0, chutesNoAlvoFora: 0, chutesParaForaCasa: 0, chutesParaForaFora: 0, posseBolaCasa: 50, posseBolaFora: 50, pressao: 0.00, xgCasa: 0.00, xgFora: 0.00,
                    momentum: { ataquesCasa: 0, ataquesFora: 0, escanteiosCasa: 0, escanteiosFora: 0, chutesNoAlvoCasa: 0, chutesNoAlvoFora: 0, chutesParaForaCasa: 0, chutesParaForaFora: 0 },
                    historicoAtqCasa: [], historicoAtqFora: [], historicoEscCasa: [], historicoEscFora: [], historicoChAlvoCasa: [], historicoChAlvoFora: [], historicoChForaCasa: [], historicoChForaFora: []
                });
                alertasDisparadosPorJogo.set(idJogo_unico, { metodo1: false, metodo2: false, golIminente1T: false, golIminente1TFora: false, golIminente2T: false, golIminente2TFora: false, layDraw: false, lay00: false, lay01: false, lay10: false, lay11: false, lay12: false, lay21: false, favoritoVence: false, favoritoVira: false });
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

