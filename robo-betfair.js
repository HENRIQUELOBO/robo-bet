// Load .env into process.env for local development
try { require('dotenv').config(); } catch(e) { /* optional */ }
const puppeteer = require('puppeteer');
const readline  = require('readline');

// Injeção dos componentes modulares do sistema Lobo Dev
const engine   = require('./engine_quant');
const logger   = require('./logger');

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
            else if (alertas && alertas.lay01)             statusLinha = "⚡ LAY 0x1";
            else if (alertas && alertas.lay10)             statusLinha = "⚡ LAY 1x0";
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
    // Puppeteer: add extra flags for WSL/headless environments and allow overriding executable via CHROME_PATH
    const launchArgs = [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-gpu',
        '--disable-dev-shm-usage',
        '--single-process',
        '--no-zygote',
        '--disable-accelerated-2d-canvas',
        '--disable-features=VizDisplayCompositor'
    ];
    const execPath = process.env.CHROME_PATH || undefined;
    const browser = await puppeteer.launch({
        headless: true,
        defaultViewport: null,
        args: launchArgs,
        executablePath: execPath
    });

    console.log(`\n🤖 ENGINE DE TELEMETRIA MODULAR PRONTA!`);



    // ─── LOOP DEDICADO AO SCREENSHOT (a cada 30s, independente do loop principal) ───
    setInterval(async () => {
        for (let [idJogo, jogo] of poolDeJogos.entries()) {
            try {
                // Se o jogo está no intervalo, pulamos o fluxo de screenshot para evitar prints inúteis
                if (jogo.noIntervalo) {
                    process.stdout.write(`[MOMENTUM] ⏸️ ${jogo.nomePartida}: jogo em intervalo — screenshot pausado\n`);
                    continue;
                }
                // Se o jogo ainda não sincronizou com o feed (sem dados estáveis), evita screenshots
                if (!jogo.sincronizadoComFeed || !jogo.tempo || jogo.tempo <= 0) {
                    process.stdout.write(`[MOMENTUM] ⏳ ${jogo.nomePartida}: sem dados estáveis ainda — screenshot adiado\n`);
                    continue;
                }

                // Procurar estritamente pelo iframe do jogo atual:
                // 1) iframe com id exato `sofascore-momentum-<idJogo>`;
                // 2) se não houver id exato, procurar iframe cujo `src` contenha o id (muitas vezes o id aparece na querystring);
                // Não usar fallback genérico que pega qualquer outro jogo na página.
                let iframeEl = await jogo.pageContext.$(`#sofascore-momentum-${idJogo}`);
                if (!iframeEl) {
                    // procura por iframe cujo src contenha o idJogo
                    const frames = await jogo.pageContext.$$('iframe');
                    for (let f of frames) {
                        try {
                            const srcHandle = await f.getProperty('src');
                            const src = srcHandle ? await srcHandle.jsonValue() : null;
                            if (src && String(src).includes(String(idJogo))) { iframeEl = f; break; }
                        } catch (e) { /* ignora erros ao ler src */ }
                    }
                }

                if (!iframeEl) {
                    const lista = await jogo.pageContext.$$eval('iframe', els =>
                        els.map(e => e.id || e.name || e.src).filter(Boolean)
                    );
                    process.stderr.write(`[MOMENTUM] ⚠️ ${jogo.nomePartida}: iframe específico sofascore-momentum-${idJogo} não encontrado. IDs/src na página: ${JSON.stringify(lista)}\n`);
                    continue;
                }

                // Aguarda a página estar estável (sem requests a decorrer)
                await jogo.pageContext.waitForNetworkIdle({ idleTime: 800, timeout: 5000 }).catch(() => {});

                // Scroll até ao elemento e aguarda render completo
                await iframeEl.evaluate(el => el.scrollIntoView({ block: 'nearest' }));
                await new Promise(r => setTimeout(r, 1200));

                // --- Fechar aviso de privacidade específico antes do screenshot
                // O site usa a seguinte estrutura de modal (exemplo):
                // <div class="cm cm--box cm--bottom cm--right" ...>
                //   ... <button class="cm__btn" data-role="all"><span>Aceitar todos</span></button>
                // </div>
                try {
                    // tenta clicar no botão 'Aceitar todos' usando seletor exato
                    const clicked = await jogo.pageContext.evaluate(() => {
                        try {
                            const sel = 'div.cm.cm--box.cm--bottom.cm--right button[data-role="all"], button.cm__btn[data-role="all"]';
                            const btn = document.querySelector(sel);
                            if (btn) { try { btn.click(); } catch(e){}; return true; }
                            return false;
                        } catch(e) { return false; }
                    }).catch(() => false);

                    if (!clicked) {
                        // tenta também dentro do iframe se for acessível
                        try {
                            const frame = await iframeEl.contentFrame();
                            if (frame) {
                                const clickedInFrame = await frame.evaluate(() => {
                                    try {
                                        const sel = 'div.cm.cm--box.cm--bottom.cm--right button[data-role="all"], button.cm__btn[data-role="all"]';
                                        const btn = document.querySelector(sel);
                                        if (btn) { try { btn.click(); } catch(e){}; return true; }
                                        return false;
                                    } catch(e) { return false; }
                                }).catch(() => false);
                                if (!clickedInFrame) {
                                    // como fallback, remove o nó do banner para evitar sobreposição
                                    await jogo.pageContext.evaluate(() => {
                                        try {
                                            const node = document.querySelector('div.cm.cm--box.cm--bottom.cm--right');
                                            if (node && node.parentElement) node.parentElement.removeChild(node);
                                        } catch(e){}
                                    }).catch(() => {});
                                }
                            } else {
                                // se não houver frame ou não for acessível, remova o banner do contexto principal
                                await jogo.pageContext.evaluate(() => {
                                    try {
                                        const node = document.querySelector('div.cm.cm--box.cm--bottom.cm--right');
                                        if (node && node.parentElement) node.parentElement.removeChild(node);
                                    } catch(e){}
                                }).catch(() => {});
                            }
                        } catch (e) {
                            // fallback: tenta remover diretamente do contexto principal
                            try { await jogo.pageContext.evaluate(() => { const node = document.querySelector('div.cm.cm--box.cm--bottom.cm--right'); if (node && node.parentElement) node.parentElement.removeChild(node); }); } catch(_){}
                        }
                    }
                } catch (e) {
                    // não fatal — seguimos para o screenshot mesmo que não tenha sido possível fechar o banner
                }

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
            // Skip entries that are being closed by the main scanner to avoid races
            if (jogo._encerrando) continue;
         }
     }, 30000);

    // Registra o callback para que o painel web possa adicionar jogos via POST /add-game
    logger.registrarCallbackAdicionarJogo(async (urlValida) => {
        const idJogo_unico = String(urlValida.split('/').pop() || Date.now());
        if (poolDeJogos.has(idJogo_unico)) return { ok: false, erro: 'Jogo já iniciado' };
        try {
            const novaAba = await browser.newPage();
            await novaAba.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36');
            await novaAba.goto(urlValida, { waitUntil: 'domcontentloaded' });
            // immediately try to dismiss cookie/privacy modals in the newly opened page
            try {
                const acceptSelectors = [
                    'button[aria-label*="accept"]', 'button[aria-label*="Aceitar"]', 'button[aria-label*="Aceitar tudo"]',
                    'button[class*="accept"]', 'button[class*="agree"]', 'button[class*="cookie"]', 'button[class*="consent"]',
                    '#onetrust-accept-btn-handler', '.onetrust-accept-btn-handler', '.gdpr-accept', '.cookie-consent button',
                    'button:contains("Aceitar")', 'button:contains("Accept")', 'button:contains("Concordo")'
                ];
                for (let sel of acceptSelectors) {
                    try {
                        const el = await novaAba.$(sel);
                        if (el) {
                            await novaAba.evaluate(s => { const e = document.querySelector(s); if (e) e.click(); }, sel);
                            await novaAba.waitForTimeout(600);
                        }
                    } catch (e) { /* ignore per-selector errors */ }
                }
            } catch (e) { /* non-fatal */ }
            poolDeJogos.set(idJogo_unico, {
                pageContext: novaAba, nomePartida: 'Carregando...', id: idJogo_unico, tempo: 0, placar: '0-0', noIntervalo: false, sincronizadoComFeed: false, momentumResetado2T: false,
                ultimoTempoRegistrado: 0, ciclosSemMudancaTempo: 0,
                betfairMarketId: null, betfairOdds: null, betfairBuscado: false,
                sofascoreMomentumImg: null, _ultimoScreenshotMomentum: 0,
                ataquesPerigososCasa: 0, ataquesPerigososFora: 0, escanteiosCasa: 0, escanteiosFora: 0, chutesNoAlvoCasa: 0, chutesNoAlvoFora: 0, chutesParaForaCasa: 0, chutesParaForaFora: 0, posseBolaCasa: 50, posseBolaFora: 50, pressao: 0.00, xgCasa: 0.00, xgFora: 0.00,
                momentum: { ataquesCasa: 0, ataquesFora: 0, escanteiosCasa: 0, escanteiosFora: 0, chutesNoAlvoCasa: 0, chutesNoAlvoFora: 0, chutesParaForaCasa: 0, chutesParaForaFora: 0 },
                historicoAtqCasa: [], historicoAtqFora: [], historicoEscCasa: [], historicoEscFora: [], historicoChAlvoCasa: [], historicoChAlvoFora: [], historicoChForaCasa: [], historicoChForaFora: [],
                _encerrando: false
            });
            // Removed keys for LAY 1x1, LAY 1x2, LAY 2x1
            alertasDisparadosPorJogo.set(idJogo_unico, { metodo1: false, metodo2: false, golIminente1T: false, golIminente1TFora: false, golIminente2T: false, golIminente2TFora: false, layDraw: false, lay00: false, lay01: false, lay10: false, favoritoVence: false, favoritoVira: false });
            return { ok: true, id: idJogo_unico };
        } catch (err) {
            return { ok: false, erro: err && err.message ? err.message : 'Erro ao abrir nova aba' };
        }
     });

    // Loop Mestre assíncrono recursivo (A cada 5 segundos)
    setInterval(async () => {
        try {
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

                        // --- Detecção robusta de 'Final da Partida' — procura pelo texto em toda a página
                        // Alguns sites mostram a palavra "Final" fora do relógio; escaneamos o body para detectar imediatamente.
                        try {
                            const bodyText = (document.body && document.body.innerText) ? document.body.innerText.toLowerCase() : '';
                            if (!statusEncerrado) {
                                if (/\bfinal\s*(da|de)?\s*partida\b/.test(bodyText) || /\bfim\s*(da|do|de)?\s*jogo\b/.test(bodyText) || bodyText.includes('resultado final') || bodyText.includes('apito final')) {
                                    statusEncerrado = true;
                                }
                            }
                        } catch (e) {}

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
                        // Mark as closing so other loops (screenshot) skip this entry and avoid races
                        jogo._encerrando = true;
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
                    // registra telemetria contínua (arquivo em log/telemetria)
                    try { logger.registrarTelemetriaContinua(jogo); } catch (e) { /* non-fatal */ }
                }

                // Invoca as validações do Motor Matemático e escrita em disco local
                try {
                    const alertasDoJogo = alertasDisparadosPorJogo.get(idJogo);
                    // Uso de process.stdout.write para garantir saída imediata no console
                    process.stdout.write(`[ENGINE_CALL] Invocando processarMotorDeRegras id=${idJogo} tempo=${jogo.tempo} placar=${jogo.placar} nome="${jogo.nomePartida || ''}"\n`);

                    // Chama o engine; suporta funções sync ou async
                    await Promise.resolve(engine.processarMotorDeRegras(idJogo, jogo, alertasDoJogo));

                    // Verifica se o engine populou a análise e loga informações resumidas
                    let analyzerInfo = 'nenhum';
                    try {
                        const ana = jogo._engineAnalysis;
                        if (ana && typeof ana === 'object') {
                            const keys = Object.keys(ana || {});
                            analyzerInfo = `${keys.length} métodos: ${keys.join(',')}`;
                        }
                    } catch (e) { analyzerInfo = 'erro ao ler analyzer'; }

                    process.stdout.write(`[ENGINE_CALL] Retorno processarMotorDeRegras id=${idJogo} tempo=${jogo.tempo} -- alertas ativos: ${Object.keys(alertasDoJogo || {}).filter(k=>alertasDoJogo[k]).join(',') || 'nenhum'} -- analyzer: ${analyzerInfo}\n`);
                 } catch (e) {
                    process.stderr.write(`[ENGINE_CALL] ERRO processarMotorDeRegras id=${idJogo} -> ${e && e.message ? e.message : e}\n`);
                 }
            } catch (err) {}
        }

        // Transmite o estado unificado para a rede (Painel HTML via streaming SSE)
        logger.atualizarDadosPainelWeb(poolDeJogos, alertasDisparadosPorJogo);

        renderizarPainelTerminal();
    } catch (e) {
        // Protege o loop principal contra exceções inesperadas — evita crash do processo
        process.stderr.write(`[MAIN_LOOP] ❌ Erro no loop principal: ${e && e.message ? e.message : e}\n`);
    }
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
            if (poolDeJogos.has(idJogo_unico)) return { ok: false, erro: 'Jogo já iniciado' };
            try {
                const novaAba = await browser.newPage();
                await novaAba.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36');
                await novaAba.goto(urlValida, { waitUntil: 'domcontentloaded' });
                // immediately try to dismiss cookie/privacy modals in the newly opened page (interactive prompt flow)
                try {
                    const acceptSelectors = [
                        'button[aria-label*="accept"]', 'button[aria-label*="Aceitar"]', 'button[aria-label*="Aceitar tudo"]',
                        'button[class*="accept"]', 'button[class*="agree"]', 'button[class*="cookie"]', 'button[class*="consent"]',
                        '#onetrust-accept-btn-handler', '.onetrust-accept-btn-handler', '.gdpr-accept', '.cookie-consent button',
                        'button:contains("Aceitar")', 'button:contains("Accept")', 'button:contains("Concordo")'
                    ];
                    for (let sel of acceptSelectors) {
                        try {
                            const el = await novaAba.$(sel);
                            if (el) {
                                await novaAba.evaluate(s => { const e = document.querySelector(s); if (e) e.click(); }, sel);
                                await novaAba.waitForTimeout(600);
                            }
                        } catch (e) { /* ignore per-selector errors */ }
                    }
                } catch (e) { /* non-fatal */ }
                poolDeJogos.set(idJogo_unico, {
                    pageContext: novaAba, nomePartida: 'Carregando...', id: idJogo_unico, tempo: 0, placar: '0-0', noIntervalo: false, sincronizadoComFeed: false, momentumResetado2T: false,
                    ultimoTempoRegistrado: 0, ciclosSemMudancaTempo: 0,
                    betfairMarketId: null, betfairOdds: null, betfairBuscado: false,
                    sofascoreMomentumImg: null, _ultimoScreenshotMomentum: 0,
                    ataquesPerigososCasa: 0, ataquesPerigososFora: 0, escanteiosCasa: 0, escanteiosFora: 0, chutesNoAlvoCasa: 0, chutesNoAlvoFora: 0, chutesParaForaCasa: 0, chutesParaForaFora: 0, posseBolaCasa: 50, posseBolaFora: 50, pressao: 0.00, xgCasa: 0.00, xgFora: 0.00,
                    momentum: { ataquesCasa: 0, ataquesFora: 0, escanteiosCasa: 0, escanteiosFora: 0, chutesNoAlvoCasa: 0, chutesNoAlvoFora: 0, chutesParaForaCasa: 0, chutesParaForaFora: 0 },
                    historicoAtqCasa: [], historicoAtqFora: [], historicoEscCasa: [], historicoEscFora: [], historicoChAlvoCasa: [], historicoChAlvoFora: [], historicoChForaCasa: [], historicoChForaFora: [],
                    _encerrando: false
                });
                // Removed keys for LAY 1x1, LAY 1x2, LAY 2x1
                alertasDisparadosPorJogo.set(idJogo_unico, { metodo1: false, metodo2: false, golIminente1T: false, golIminente1TFora: false, golIminente2T: false, golIminente2TFora: false, layDraw: false, lay00: false, lay01: false, lay10: false, favoritoVence: false, favoritoVira: false });
            } catch (err) {
                return { ok: false, erro: err && err.message ? err.message : 'Erro ao abrir nova aba' };
            }
        });
    }

    process.stdin.resume();
    process.stdin.on('keypress', (str, key) => {
        if (key.ctrl && key.name === 'c') process.exit();
        if (key.name === 'space') abrirPromptNovaAba();
    });
}

iniciarRobo().catch(err => console.error(err));



