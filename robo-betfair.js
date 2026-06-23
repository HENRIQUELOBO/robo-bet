try {
    require('dotenv').config();
} catch (e) { /* optional */
}
const puppeteer = require('puppeteer');
const readline = require('readline');
let globalBrowser = null;

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
        let statusLinha = "Escaneando...";

        if (jogo.noIntervalo) {
            statusLinha = "⏸️ INTERVALO";
        } else {
            const alertas = alertasDisparadosPorJogo.get(id);
            if (alertas && alertas.golIminente2T) statusLinha = "🚨 GATILHO 2T!";
            else if (alertas && alertas.golIminente2TFora) statusLinha = "🚨 GATILHO 2T FORA";
            else if (alertas && alertas.favoritoVira) statusLinha = "🔄 FAVORITO VIRA";
            else if (alertas && alertas.favoritoVence) statusLinha = "💰 FAVORITO VENCE";
            else if (alertas && alertas.golIminente1T) statusLinha = "🔥 GATILHO 1T!";
            else if (alertas && alertas.golIminente1TFora) statusLinha = "🔥 GATILHO 1T FORA";
            else if (alertas && alertas.layDraw) statusLinha = "🏆 LAY DRAW";
            else if (alertas && alertas.lay01) statusLinha = "⚡ LAY 0x1";
            else if (alertas && alertas.lay10) statusLinha = "⚡ LAY 1x0";
            else if (alertas && alertas.lay00) statusLinha = "🔵 LAY 0x0";
        }

        console.log(`🏟️ Partida:  ${jogo.nomePartida.padEnd(55)}`);
        console.log(`⏱️ Min: ${String(jogo.tempo).padStart(2)}' | Placar: ${jogo.placar.padEnd(5)} | Pressão Total: ${jogo.pressao.toFixed(2)} APM | xG: C:${jogo.xgCasa.toFixed(2)} - F:${jogo.xgFora.toFixed(2)}`);
        console.log(`🔬 Micro10m: APM:(${jogo.momentum.ataquesCasa}/${jogo.momentum.ataquesFora}) Chutes:(${jogo.momentum.chutesNoAlvoCasa}/${jogo.momentum.chutesNoAlvoFora}) Esc:(${jogo.momentum.escanteiosCasa}/${jogo.momentum.escanteiosFora})`);
        console.log(`⚡ Status:    ${statusLinha}`);
        console.log("--------------------------------------------------------------------");
    }
    console.log("[Espaço] Adicionar Novo Jogo | [Ctrl+C] Encerrar Sistema");
    console.log("====================================================================");
}

async function iniciarRobo() {
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
    globalBrowser = browser;

    setInterval(async () => {
        for (let [idJogo, jogo] of poolDeJogos.entries()) {
            try {
                if (jogo.noIntervalo) {
                    process.stdout.write(`[MOMENTUM] ⏸️ ${jogo.nomePartida}: jogo em intervalo — screenshot pausado\n`);
                    continue;
                }

                if (!jogo.sincronizadoComFeed || !jogo.tempo || jogo.tempo <= 0) {
                    process.stdout.write(`[MOMENTUM] ⏳ ${jogo.nomePartida}: sem dados estáveis ainda — screenshot adiado\n`);
                    continue;
                }

                let iframeEl = await jogo.pageContext.$(`#sofascore-momentum-${idJogo}`);
                if (!iframeEl) {
                    const frames = await jogo.pageContext.$$('iframe');
                    for (let f of frames) {
                        try {
                            const srcHandle = await f.getProperty('src');
                            const src = srcHandle ? await srcHandle.jsonValue() : null;
                            if (src && String(src).includes(String(idJogo))) {
                                iframeEl = f;
                                break;
                            }
                        } catch (e) { /* ignora erros ao ler src */
                        }
                    }
                }

                if (!iframeEl) {
                    const lista = await jogo.pageContext.$$eval('iframe', els =>
                        els.map(e => e.id || e.name || e.src).filter(Boolean)
                    );
                    process.stderr.write(`[MOMENTUM] ⚠️ ${jogo.nomePartida}: iframe específico sofascore-momentum-${idJogo} não encontrado. IDs/src na página: ${JSON.stringify(lista)}\n`);
                    continue;
                }

                await jogo.pageContext.waitForNetworkIdle({idleTime: 800, timeout: 5000}).catch(() => {
                });
                await iframeEl.evaluate(el => el.scrollIntoView({block: 'nearest'}));
                await new Promise(r => setTimeout(r, 1200));

                try {
                    const clicked = await jogo.pageContext.evaluate(() => {
                        try {
                            const sel = 'div.cm.cm--box.cm--bottom.cm--right button[data-role="all"], button.cm__btn[data-role="all"]';
                            const btn = document.querySelector(sel);
                            if (btn) {
                                try {
                                    btn.click();
                                } catch (e) {
                                }
                                ;
                                return true;
                            }
                            return false;
                        } catch (e) {
                            return false;
                        }
                    }).catch(() => false);

                    if (!clicked) {
                        try {
                            const frame = await iframeEl.contentFrame();
                            if (frame) {
                                const clickedInFrame = await frame.evaluate(() => {
                                    try {
                                        const sel = 'div.cm.cm--box.cm--bottom.cm--right button[data-role="all"], button.cm__btn[data-role="all"]';
                                        const btn = document.querySelector(sel);
                                        if (btn) {
                                            try {
                                                btn.click();
                                            } catch (e) {
                                            }
                                            ;
                                            return true;
                                        }
                                        return false;
                                    } catch (e) {
                                        return false;
                                    }
                                }).catch(() => false);

                                if (!clickedInFrame) {
                                    await jogo.pageContext.evaluate(() => {
                                        try {
                                            const node = document.querySelector('div.cm.cm--box.cm--bottom.cm--right');
                                            if (node && node.parentElement) node.parentElement.removeChild(node);
                                        } catch (e) {
                                        }
                                    }).catch(() => {
                                    });
                                }
                            } else {
                                await jogo.pageContext.evaluate(() => {
                                    try {
                                        const node = document.querySelector('div.cm.cm--box.cm--bottom.cm--right');
                                        if (node && node.parentElement) node.parentElement.removeChild(node);
                                    } catch (e) {
                                    }
                                }).catch(() => {
                                });
                            }
                        } catch (e) {
                            try {
                                await jogo.pageContext.evaluate(() => {
                                    const node = document.querySelector('div.cm.cm--box.cm--bottom.cm--right');
                                    if (node && node.parentElement) node.parentElement.removeChild(node);
                                });
                            } catch (_) {
                            }
                        }
                    }
                } catch (e) {

                }

                const box = await iframeEl.boundingBox();
                if (!box || box.width < 10 || box.height < 10) {
                    process.stderr.write(`[MOMENTUM] ⚠️ ${jogo.nomePartida}: boundingBox inválido ${JSON.stringify(box)}\n`);
                    continue;
                }

                const tryWindowSeconds = 12; // increase window to 12s
                const tryIntervalMs = 2000; // 800ms between attempts (slightly slower)
                const minKb = 30; // require at least 30KB

                const candidates = [];

                const takeOne = async () => {
                    let shot = null;
                    try {
                        shot = await iframeEl.screenshot({ encoding: 'base64', type: 'jpeg', quality: 80 }).catch(() => null);
                    } catch (e) {
                        shot = null;
                    }
                    if (!shot) {
                        shot = await jogo.pageContext.screenshot({
                            encoding: 'base64',
                            type: 'jpeg',
                            quality: 80,
                            clip: { x: Math.max(0, box.x), y: Math.max(0, box.y), width: box.width, height: box.height }
                        }).catch(() => null);
                    }
                    return shot;
                };

                // First try: single attempt (fast path)
                try {
                    const first = await takeOne();
                    if (first) candidates.push(first);
                } catch (_) { }

                // If first is missing or too small, perform repeated 1s captures for a short window
                try {
                    const firstSizeKB = (candidates[0] || '').length / 1024 || 0;
                    if (!candidates[0] || firstSizeKB < minKb) {
                        const attempts = Math.max(1, Math.floor(tryWindowSeconds * 1000 / tryIntervalMs));
                        for (let i = 0; i < attempts; i++) {
                            await new Promise(r => setTimeout(r, tryIntervalMs));
                            try {
                                const s = await takeOne();
                                if (s) candidates.push(s);
                            } catch (_) { }
                        }
                    }
                } catch (_) { }

                if (candidates.length === 0) {
                    process.stderr.write(`[MOMENTUM] ⚠️ ${jogo.nomePartida}: não foi possível capturar screenshot (nenhuma imagem)\n`);
                    continue;
                }

                // Strategy: take multiple quick snapshots (1s interval) for a short window and pick the best
                // This reduces the chance of capturing during finalizing redraws. We keep the existing
                // iframe element screenshot preference but will take several attempts and choose the
                // largest non-blank image.
                const extraRetriesIfSmall = 10; // extra attempts if best < minKb (allow more retries on slow servers)

                let best = null; bestSize = 0;
                for (let c of candidates) {
                    try {
                        const kb = (c || '').length / 1024;
                        if (kb > bestSize) {
                            bestSize = kb;
                            best = c;
                        }
                    } catch (e) { }
                }

                if (!best || bestSize < minKb) {
                    // If the best candidate is smaller than desired, perform a few extra attempts
                    process.stderr.write(`[MOMENTUM] ⚠️ ${jogo.nomePartida}: melhor candidata pequena (${bestSize.toFixed(1)}KB) — tentando ${extraRetriesIfSmall} tentativas extras\n`);
                    for (let r = 0; r < extraRetriesIfSmall; r++) {
                        await new Promise(res => setTimeout(res, tryIntervalMs));
                        try {
                            const s = await takeOne();
                            if (s) candidates.push(s);
                        } catch (_) {}
                    }

                    // re-evaluate best after extras
                    best = null; bestSize = 0;
                    for (let c of candidates) {
                        try {
                            const kb = (c || '').length / 1024;
                            if (kb > bestSize) {
                                bestSize = kb;
                                best = c;
                            }
                        } catch (e) { }
                    }

                    if (!best || bestSize < minKb) {
                        process.stderr.write(`[MOMENTUM] ⚠️ ${jogo.nomePartida}: após tentativas extras melhores candidatas ainda pequenas (${bestSize.toFixed(1)}KB) — ignorada\n`);
                        continue;
                    }
                }

                try {
                    const dataUrl = `data:image/jpeg;base64,${best}`;
                    jogo.sofascoreMomentumImg = dataUrl;
                    logger.registrarScreenshotMomentum(idJogo, dataUrl);
                    process.stdout.write(`[MOMENTUM] ✅ ${jogo.nomePartida}: ${bestSize.toFixed(1)}KB (melhor de ${candidates.length} tentativas)\n`);
                } catch (e) {
                    process.stderr.write(`[MOMENTUM] ❌ ${jogo.nomePartida}: falha ao salvar screenshot -> ${e && e.message ? e.message : e}\n`);
                }
            } catch (e) {
                process.stderr.write(`[MOMENTUM] ❌ ${jogo.nomePartida}: ${e.message}\n`);
            }

            if (jogo._encerrando) continue;
        }
    }, 30000);

    logger.registrarCallbackAdicionarJogo(async (urlValida) => {
        const idJogo_unico = String(urlValida.split('/').pop() || Date.now());
        if (poolDeJogos.has(idJogo_unico)) return {ok: false, erro: 'Jogo já iniciado'};
        try {
            const novaAba = await browser.newPage();
            await novaAba.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36');
            await novaAba.goto(urlValida, {waitUntil: 'domcontentloaded'});

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
                            await novaAba.evaluate(s => {
                                const e = document.querySelector(s);
                                if (e) e.click();
                            }, sel);
                            await novaAba.waitForTimeout(600);
                        }
                    } catch (e) { /* ignore per-selector errors */
                        console.warn(`[acceptSelectors] ${sel} erro: ${e}`);
                    }
                }
            } catch (e) { /* non-fatal */
                console.warn(`[acceptSelectors] erro: ${e}`);
            }

            poolDeJogos.set(idJogo_unico, {
                pageContext: novaAba,
                nomePartida: 'Carregando...',
                id: idJogo_unico,
                tempo: 0,
                placar: '0-0',
                noIntervalo: false,
                sincronizadoComFeed: false,
                momentumResetado2T: false,
                ultimoTempoRegistrado: 0,
                ciclosSemMudancaTempo: 0,
                betfairMarketId: null,
                betfairOdds: null,
                betfairBuscado: false,
                sofascoreMomentumImg: null,
                _ultimoScreenshotMomentum: 0,
                ataquesPerigososCasa: 0,
                ataquesPerigososFora: 0,
                escanteiosCasa: 0,
                escanteiosFora: 0,
                chutesNoAlvoCasa: 0,
                chutesNoAlvoFora: 0,
                chutesParaForaCasa: 0,
                chutesParaForaFora: 0,
                posseBolaCasa: 50,
                posseBolaFora: 50,
                pressao: 0.00,
                xgCasa: 0.00,
                xgFora: 0.00,
                momentum: {
                    ataquesCasa: 0,
                    ataquesFora: 0,
                    escanteiosCasa: 0,
                    escanteiosFora: 0,
                    chutesNoAlvoCasa: 0,
                    chutesNoAlvoFora: 0,
                    chutesParaForaCasa: 0,
                    chutesParaForaFora: 0
                },
                historicoAtqCasa: [],
                historicoAtqFora: [],
                historicoEscCasa: [],
                historicoEscFora: [],
                historicoChAlvoCasa: [],
                historicoChAlvoFora: [],
                historicoChForaCasa: [],
                historicoChForaFora: [],
                _encerrando: false
            });

            alertasDisparadosPorJogo.set(idJogo_unico, {
                metodo1: false,
                metodo2: false,
                golIminente1T: false,
                golIminente1TFora: false,
                golIminente2T: false,
                golIminente2TFora: false,
                layDraw: false,
                lay00: false,
                lay01: false,
                lay10: false,
                favoritoVence: false,
                favoritoVira: false
            });
            return {ok: true, id: idJogo_unico};
        } catch (err) {
            return {ok: false, erro: err && err.message ? err.message : 'Erro ao abrir nova aba'};
        }
    });

    setInterval(async () => {
        try {
            if (poolDeJogos.size === 0) return;

            for (let [idJogo, jogo] of poolDeJogos.entries()) {
                try {
                    const dadosContexto = await jogo.pageContext.evaluate(() => {
                        let info = {timeCasa: '', timeFora: '', tituloAba: document.title};
                        let rootDiv = document.querySelector('[wire\\:snapshot]');

                        if (rootDiv) {
                            try {
                                let snapshot = JSON.parse(rootDiv.getAttribute('wire:snapshot'));
                                let d = snapshot && snapshot.data;
                                if (d) {
                                    info.timeCasa = d.timeCasa || d.homeTeam || d.home_team || d.homeName || d.team_home || '';
                                    info.timeFora = d.timeFora || d.awayTeam || d.away_team || d.awayName || d.team_away || '';
                                }
                            } catch (e) {
                            }
                        }

                        if (!info.timeCasa || !info.timeFora) {
                            const seletoresCasa = ['.home-team-name', '.home .team-name', '[class*="homeTeam"] [class*="name"]', '[class*="home-team"]', '.participant-name.home', '[data-home-team]'];
                            const seletoresFora = ['.away-team-name', '.away .team-name', '[class*="awayTeam"] [class*="name"]', '[class*="away-team"]', '.participant-name.away', '[data-away-team]'];
                            for (let sel of seletoresCasa) {
                                let el = document.querySelector(sel);
                                if (el && el.textContent.trim()) {
                                    info.timeCasa = el.textContent.trim();
                                    break;
                                }
                            }
                            for (let sel of seletoresFora) {
                                let el = document.querySelector(sel);
                                if (el && el.textContent.trim()) {
                                    info.timeFora = el.textContent.trim();
                                    break;
                                }
                            }
                        }

                        if (!info.timeCasa || !info.timeFora) {
                            let metaOg = document.querySelector('meta[property="og:title"]') || document.querySelector('meta[name="title"]');
                            if (metaOg) info.tituloAba = metaOg.getAttribute('content') || info.tituloAba;
                        }

                        return info;
                    });

                    if (dadosContexto.timeCasa && dadosContexto.timeFora) {
                        jogo.nomePartida = `${dadosContexto.timeCasa} v ${dadosContexto.timeFora}`;
                    } else if (dadosContexto.tituloAba) {
                        let tit = dadosContexto.tituloAba;
                        let match = tit.match(/^(.+?)\s+(?:vs\.?|v|x)\s+(.+?)(?:\s*[-|]|$)/i);

                        if (match) {
                            jogo.nomePartida = `${match[1].trim()} v ${match[2].trim()}`;
                        } else if (tit && !tit.toLowerCase().includes('radar') && !tit.toLowerCase().includes('futebol') && tit.length > 5) {
                            jogo.nomePartida = tit.split('|')[0].trim();
                        }
                    }

                    const todosOsFrames = await jogo.pageContext.frames();
                    let frameRadar = todosOsFrames.find(f =>
                        f.url().includes('radarfutebol.xyz/scoreboards') ||
                        f.name() === 'iframe-williamhill'
                    );

                    let contextoAlvo = frameRadar ? frameRadar : jogo.pageContext;

                    const r = await contextoAlvo.evaluate(() => {
                        let tempoLocal = 0;
                        let placarLocal = '';
                        let statusIntervalo = false;
                        let statusEncerrado = false;
                        let atqC = 0, atqF = 0, escC = 0, escF = 0, chC = 0, chF = 0, chForaC = 0, chForaF = 0,
                            posseC = 50, posseF = 50;

                        let spanRelogio = document.querySelector(
                            '[data-push="clock"], .clockWrapper span, .match-clock, .match-time, ' +
                            '[class*="clock"], [class*="Clock"], [class*="timer"], [class*="Timer"], ' +
                            '.period-time, .live-time, .game-time, [data-testid="match-time"]'
                        );
                        if (spanRelogio && spanRelogio.textContent) {
                            let textoCru = spanRelogio.textContent.trim().toLowerCase();

                            if (textoCru.includes('fim') || textoCru.includes('ft') || textoCru.includes('encerrado') ||
                                textoCru.includes('terminado') || textoCru.includes('encerrada') || textoCru.includes('terminada') ||
                                textoCru.includes('full time') || textoCru.includes('fulltime') || textoCru.includes('final') ||
                                textoCru.includes('resultado final') || textoCru.includes('ended') || textoCru.includes('finished') ||
                                textoCru.includes('apito final')) {
                                statusEncerrado = true;
                            } else if (textoCru.includes('intervalo') || textoCru.includes('ht') || textoCru.includes('int')) {
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

                        if (!statusEncerrado) {
                            let ftBadge = document.querySelector(
                                '.ft-badge, .status-ft, [class*="fulltime"], [class*="full-time"], ' +
                                '[class*="finished"], [class*="ended"], [class*="status-ended"], ' +
                                '[data-status="FT"], [data-status="ft"], [data-status="finished"]'
                            );
                            if (ftBadge) statusEncerrado = true;
                        }

                        if (!statusEncerrado) {
                            let statusEl = document.querySelector('.match-status, .game-status, .status-label, [class*="matchStatus"], [class*="gameStatus"]');
                            if (statusEl) {
                                let st = statusEl.textContent.trim().toLowerCase();
                                if (st.includes('ft') || st.includes('fim') || st.includes('terminado') || st.includes('encerrado') || st.includes('final') || st.includes('finished') || st.includes('ended')) {
                                    statusEncerrado = true;
                                }
                            }
                        }

                        try {
                            const bodyText = (document.body && document.body.innerText) ? document.body.innerText.toLowerCase() : '';
                            if (!statusEncerrado) {
                                if (/\bfinal\s*(da|de)?\s*partida\b/.test(bodyText) || /\bfim\s*(da|do|de)?\s*jogo\b/.test(bodyText) || bodyText.includes('resultado final') || bodyText.includes('apito final')) {
                                    statusEncerrado = true;
                                }
                            }
                        } catch (e) {
                        }

                        let nósTexto = Array.from(document.querySelectorAll('div, span, p, b')).map(el => el.textContent ? el.textContent.trim() : '');
                        let matchPlacar = nósTexto.find(t => /^\d+\s*-\s*\d+$/.test(t));
                        if (matchPlacar) placarLocal = matchPlacar.replace(/\s+/g, '');

                        let momentumSrc = '';
                        const iframeMomentum = document.querySelector('[id^="sofascore-momentum-"]');
                        if (iframeMomentum) {
                            momentumSrc = iframeMomentum.src || iframeMomentum.getAttribute('src') || '';
                        }

                        let wrapper = document.getElementById('stats_wrapper');
                        if (wrapper) {
                            let blocoAtq = wrapper.querySelector(
                                '[data-stat="dangerousAttacks"], [data-stat="dangerous_attacks"], ' +
                                '[data-stat="dangerousattacks"], [data-stat="DangerousAttacks"], ' +
                                '[data-stat="attacks"], [data-stat="Attacks"]'
                            );

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

                            let blocoFora = wrapper.querySelector('[data-stat="statsOffTarget"], [data-stat="shotsOffTarget"]');
                            if (blocoFora) {
                                chForaC = parseInt(blocoFora.querySelector('.home')?.textContent || '0') || 0;
                                chForaF = parseInt(blocoFora.querySelector('.away')?.textContent || '0') || 0;
                            }

                            let blocoPosse = wrapper.querySelector('[data-stat="possession"], [data-stat="BallPossession"]');
                            if (blocoPosse) {
                                posseC = parseInt(blocoPosse.querySelector('.home')?.textContent?.replace(/[^0-9]/g, '')) || 50;
                                posseF = parseInt(blocoPosse.querySelector('.away')?.textContent?.replace(/[^0-9]/g, '')) || 50;
                            }
                        }

                        return {
                            tempoLocal,
                            placarLocal,
                            statusIntervalo,
                            statusEncerrado,
                            atqC,
                            atqF,
                            escC,
                            escF,
                            chC,
                            chF,
                            chForaC,
                            chForaF,
                            posseC,
                            posseF,
                            momentumSrc
                        };
                    });

                    if (r) {
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

                        if (r.statusEncerrado) {
                            jogo._encerrando = true;
                            try {
                                await jogo.pageContext.close();
                            } catch (e) {
                            }

                            poolDeJogos.delete(idJogo);
                            alertasDisparadosPorJogo.delete(idJogo);

                            logger.atualizarDadosPainelWeb(poolDeJogos, alertasDisparadosPorJogo);
                            continue;
                        }

                        jogo.noIntervalo = r.statusIntervalo;

                        if (r.statusIntervalo) {
                            if (r.tempoLocal > 0 && r.tempoLocal >= jogo.tempo) jogo.tempo = r.tempoLocal;
                            if (r.placarLocal && r.placarLocal.includes('-')) jogo.placar = r.placarLocal;
                            continue;
                        }

                        if (r.tempoLocal > 0 && r.tempoLocal >= jogo.tempo) jogo.tempo = r.tempoLocal;
                        if (r.placarLocal && r.placarLocal.includes('-')) jogo.placar = r.placarLocal;

                        let minAtual = jogo.tempo;

                        if (!jogo.sincronizadoComFeed) {
                            jogo.ataquesPerigososCasa = r.atqC;
                            jogo.ataquesPerigososFora = r.atqF;
                            jogo.escanteiosCasa = r.escC;
                            jogo.escanteiosFora = r.escF;
                            jogo.chutesNoAlvoCasa = r.chC;
                            jogo.chutesNoAlvoFora = r.chF;
                            jogo.chutesParaForaCasa = r.chForaC;
                            jogo.chutesParaForaFora = r.chForaF;
                            jogo.posseBolaCasa = r.posseC;
                            jogo.posseBolaFora = r.posseF;
                            jogo.sincronizadoComFeed = true;
                            continue;
                        }

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
                            if (r.atqC > jogo.ataquesPerigososCasa) {
                                let delta = r.atqC - jogo.ataquesPerigososCasa;
                                if (delta <= 4) {
                                    for (let i = 0; i < delta; i++) jogo.historicoAtqCasa.push(minAtual);
                                }
                            }

                            if (r.atqF > jogo.ataquesPerigososFora) {
                                let delta = r.atqF - jogo.ataquesPerigososFora;
                                if (delta <= 4) {
                                    for (let i = 0; i < delta; i++) jogo.historicoAtqFora.push(minAtual);
                                }
                            }

                            if (r.escC > jogo.escanteiosCasa) {
                                let delta = r.escC - jogo.escanteiosCasa;
                                if (delta <= 2) {
                                    for (let i = 0; i < delta; i++) jogo.historicoEscCasa.push(minAtual);
                                }
                            }

                            if (r.escF > jogo.escanteiosFora) {
                                let delta = r.escF - jogo.escanteiosFora;
                                if (delta <= 2) {
                                    for (let i = 0; i < delta; i++) jogo.historicoEscFora.push(minAtual);
                                }
                            }

                            if (r.chC > jogo.chutesNoAlvoCasa) {
                                let delta = r.chC - jogo.chutesNoAlvoCasa;
                                if (delta <= 2) {
                                    for (let i = 0; i < delta; i++) jogo.historicoChAlvoCasa.push(minAtual);
                                }
                            }

                            if (r.chF > jogo.chutesNoAlvoFora) {
                                let delta = r.chF - jogo.chutesNoAlvoFora;
                                if (delta <= 2) {
                                    for (let i = 0; i < delta; i++) jogo.historicoChAlvoFora.push(minAtual);
                                }
                            }

                            if (r.chForaC > jogo.chutesParaForaCasa) {
                                let delta = r.chForaC - jogo.chutesParaForaCasa;
                                if (delta <= 2) {
                                    for (let i = 0; i < delta; i++) jogo.historicoChForaCasa.push(minAtual);
                                }
                            }

                            if (r.chForaF > jogo.chutesParaForaFora) {
                                let delta = r.chForaF - jogo.chutesParaForaFora;
                                if (delta <= 2) {
                                    for (let i = 0; i < delta; i++) jogo.historicoChForaFora.push(minAtual);
                                }
                            }

                            jogo.ataquesPerigososCasa = r.atqC;
                            jogo.ataquesPerigososFora = r.atqF;
                            jogo.escanteiosCasa = r.escC;
                            jogo.escanteiosFora = r.escF;
                            jogo.chutesNoAlvoCasa = r.chC;
                            jogo.chutesNoAlvoFora = r.chF;
                            jogo.chutesParaForaCasa = r.chForaC;
                            jogo.chutesParaForaFora = r.chForaF;
                        }

                        if (r.posseC > 0) {
                            jogo.posseBolaCasa = r.posseC;
                            jogo.posseBolaFora = r.posseF;
                        }

                        if (r.momentumSrc) jogo.sofascoreMomentumUrl = r.momentumSrc;

                        try {
                            logger.registrarTelemetriaContinua(jogo);
                        } catch (e) { /* non-fatal */
                        }
                    }

                    try {
                        const alertasDoJogo = alertasDisparadosPorJogo.get(idJogo);

                        process.stdout.write(`[ENGINE_CALL] Invocando processarMotorDeRegras id=${idJogo} tempo=${jogo.tempo} placar=${jogo.placar} nome="${jogo.nomePartida || ''}"\n`);
                        await Promise.resolve(engine.processarMotorDeRegras(idJogo, jogo, alertasDoJogo));

                        let analyzerInfo = 'nenhum';
                        try {
                            const ana = jogo._engineAnalysis;
                            if (ana && typeof ana === 'object') {
                                const keys = Object.keys(ana || {});
                                analyzerInfo = `${keys.length} métodos: ${keys.join(',')}`;
                            }
                        } catch (e) {
                            analyzerInfo = 'erro ao ler analyzer';
                        }

                        process.stdout.write(`[ENGINE_CALL] Retorno processarMotorDeRegras id=${idJogo} tempo=${jogo.tempo} -- alertas ativos: ${Object.keys(alertasDoJogo || {}).filter(k => alertasDoJogo[k]).join(',') || 'nenhum'} -- analyzer: ${analyzerInfo}\n`);
                    } catch (e) {
                        process.stderr.write(`[ENGINE_CALL] ERRO processarMotorDeRegras id=${idJogo} -> ${e && e.message ? e.message : e}\n`);
                    }
                } catch (err) {
                }
            }

            logger.atualizarDadosPainelWeb(poolDeJogos, alertasDisparadosPorJogo);
            renderizarPainelTerminal();
        } catch (e) {

            process.stderr.write(`[MAIN_LOOP] ❌ Erro no loop principal: ${e && e.message ? e.message : e}\n`);
        }
    }, 5000);

    function abrirPromptNovaAba() {
        if (process.stdin.isTTY) process.stdin.setRawMode(false);
        process.stdin.pause();
        const rl = readline.createInterface({input: process.stdin, output: process.stdout, terminal: true});
        console.log("\n--------------------------------------------------------------------");
        rl.question('🔗 Cole a URL do jogo do RadarFutebol para adicionar ao Pool: ', async (urlDigitada) => {
            rl.close();
            if (process.stdin.isTTY) process.stdin.setRawMode(true);
            process.stdin.resume();

            const urlValida = urlDigitada.trim();
            if (!urlValida.startsWith('http')) return;

            const idJogo_unico = String(urlValida.split('/').pop() || Date.now());
            if (poolDeJogos.has(idJogo_unico)) return {ok: false, erro: 'Jogo já iniciado'};
            try {
                const novaAba = await browser.newPage();
                await novaAba.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36');
                await novaAba.goto(urlValida, {waitUntil: 'domcontentloaded'});

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
                                await novaAba.evaluate(s => {
                                    const e = document.querySelector(s);
                                    if (e) e.click();
                                }, sel);
                                await novaAba.waitForTimeout(600);
                            }
                        } catch (e) { /* ignore per-selector errors */
                        }
                    }
                } catch (e) { /* non-fatal */
                }
                poolDeJogos.set(idJogo_unico, {
                    pageContext: novaAba,
                    nomePartida: 'Carregando...',
                    id: idJogo_unico,
                    tempo: 0,
                    placar: '0-0',
                    noIntervalo: false,
                    sincronizadoComFeed: false,
                    momentumResetado2T: false,
                    ultimoTempoRegistrado: 0,
                    ciclosSemMudancaTempo: 0,
                    betfairMarketId: null,
                    betfairOdds: null,
                    betfairBuscado: false,
                    sofascoreMomentumImg: null,
                    _ultimoScreenshotMomentum: 0,
                    ataquesPerigososCasa: 0,
                    ataquesPerigososFora: 0,
                    escanteiosCasa: 0,
                    escanteiosFora: 0,
                    chutesNoAlvoCasa: 0,
                    chutesNoAlvoFora: 0,
                    chutesParaForaCasa: 0,
                    chutesParaForaFora: 0,
                    posseBolaCasa: 50,
                    posseBolaFora: 50,
                    pressao: 0.00,
                    xgCasa: 0.00,
                    xgFora: 0.00,
                    momentum: {
                        ataquesCasa: 0,
                        ataquesFora: 0,
                        escanteiosCasa: 0,
                        escanteiosFora: 0,
                        chutesNoAlvoCasa: 0,
                        chutesNoAlvoFora: 0,
                        chutesParaForaCasa: 0,
                        chutesParaForaFora: 0
                    },
                    historicoAtqCasa: [],
                    historicoAtqFora: [],
                    historicoEscCasa: [],
                    historicoEscFora: [],
                    historicoChAlvoCasa: [],
                    historicoChAlvoFora: [],
                    historicoChForaCasa: [],
                    historicoChForaFora: [],
                    _encerrando: false
                });

                alertasDisparadosPorJogo.set(idJogo_unico, {
                    metodo1: false,
                    metodo2: false,
                    golIminente1T: false,
                    golIminente1TFora: false,
                    golIminente2T: false,
                    golIminente2TFora: false,
                    layDraw: false,
                    lay00: false,
                    lay01: false,
                    lay10: false,
                    favoritoVence: false,
                    favoritoVira: false
                });
            } catch (err) {
                return {ok: false, erro: err && err.message ? err.message : 'Erro ao abrir nova aba'};
            }
        });
    }

    process.stdin.resume();
    process.stdin.on('keypress', (str, key) => {
        if (key.ctrl && key.name === 'c') process.exit();
        if (key.name === 'space') abrirPromptNovaAba();
    });
}

async function _gracefulShutdown(signal) {
    try {
        console.log(`[betfair] ${signal} recebido, encerrando...`);

        try {
            for (let [id, jogo] of poolDeJogos.entries()) {
                try {
                    jogo._encerrando = true;
                    if (jogo.pageContext && jogo.pageContext.close) await jogo.pageContext.close();
                } catch (_) {
                }
            }
        } catch (_) {
        }
        if (globalBrowser) {
            try {
                await globalBrowser.close();
            } catch (e) {
                console.warn('[betfair] erro fechando browser:', e && e.message ? e.message : e);
            }
            globalBrowser = null;
        }
    } catch (e) {
    }
    process.exit(0);
}

process.on('SIGINT', () => _gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => _gracefulShutdown('SIGTERM'));
process.on('exit', () => {
    if (globalBrowser) {
        try {
            globalBrowser.close().catch(() => {
            });
        } catch (_) {
        }
        globalBrowser = null;
    }
});

iniciarRobo().catch(err => console.error(err));



