try {
    require('dotenv').config();
} catch (e) {
}
const puppeteer = require('puppeteer');
const readline = require('readline');
const fs = require('fs');
let globalBrowser = null;

const DEBUG_BLOCKED = process.env.DEBUG_BLOCKED_REQUESTS === '1';
const WHITELIST_HOSTNAMES = (process.env.WHITELIST_HOSTNAMES || '').split(',').map(s => s.trim()).filter(Boolean);

const engine = require('./engine_quant');
const logger = require('./logger');

// Proteções e tempos globais
const EVAL_TIMEOUT_MS = 10000; // 10s para qualquer evaluate/extração
const GOTO_TIMEOUT_MS = 10000; // 10s para navigations/goto
const WATCHDOG_INATIVIDADE_MS = 3 * 60 * 1000; // 3 minutos
const RELOAD_INTERVAL_MS = 10 * 60 * 1000; // recarregar a cada 10 minutos por segurança

// Helper para proteger evaluate() e evitar Promises pendentes
async function safeEvaluate(frameOrPage, fn, ...args) {
    return await Promise.race([
        frameOrPage.evaluate(fn, ...args),
        new Promise((_, reject) => setTimeout(() => reject(new Error('evaluate timeout')), EVAL_TIMEOUT_MS))
    ]);
}

// Wrapper around safeEvaluate that protects the watchdog from transient evaluate failures.
// If an evaluate times out or throws, we log a warning and refresh the game's "_ultimaAtualizacao"
// timestamp to avoid immediate watchdog restarts for short-lived evaluate problems.
async function safeEvaluateWithWatchdog(jogo, frameOrPage, fn, ...args) {
    try {
        const res = await safeEvaluate(frameOrPage, fn, ...args);
        // successful evaluate -> update timestamp
        try { if (jogo) jogo._ultimaAtualizacao = Date.now(); } catch (e) {}
        return res;
    } catch (err) {
        try {
            const id = jogo && jogo.id ? jogo.id : 'unknown';
            process.stderr.write(`[WATCHDOG_HELPER] evaluate failed for id=${id} -> ${err && err.message ? err.message : err}\n`);
            // give a small grace so a single evaluate timeout doesn't trigger the watchdog
            if (jogo) jogo._ultimaAtualizacao = Date.now();
        } catch (e) {}
        // If the error is a detached frame (common when the page reloads or iframe is removed),
        // try a safe fallback: run the evaluate on the top-level page (if available) once.
        try {
            const msg = (err && err.message) ? err.message.toLowerCase() : '';
            if (msg.includes('detached') || msg.includes('detached frame') || msg.includes('frame is detached')) {
                try {
                    if (jogo && jogo.pageContext && typeof jogo.pageContext.evaluate === 'function' && jogo.pageContext !== frameOrPage) {
                        process.stderr.write(`[WATCHDOG_HELPER] frame detached for id=${jogo.id}, retrying evaluate on top-level page\n`);
                        const res2 = await Promise.race([
                            jogo.pageContext.evaluate(fn, ...args),
                            new Promise((_, reject) => setTimeout(() => reject(new Error('evaluate timeout (fallback)')), EVAL_TIMEOUT_MS))
                        ]);
                        try { if (jogo) jogo._ultimaAtualizacao = Date.now(); } catch (e) {}
                        return res2;
                    }
                } catch (e) {
                    // fallback failed — will rethrow original error below
                }
            }
        } catch (e) {}

        // rethrow so callers can still handle if needed
        throw err;
    }
}

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

            if (alertas) {
                const orderedChecks = [
                    ['goliminente2t',        "🚨 gatilho 2t!"],
                    ['goliminente2tfora',    "🚨 gatilho 2t fora"],
                    ['favoritovira',         "🔄 favorito vira"],
                    ['favoritovence',        "💰 favorito vence"],
                    ['goliminente1t',        "🔥 gatilho 1t!"],
                    ['goliminente1tfora',    "🔥 gatilho 1t fora"],
                    ['laydraw',              "🏆 lay draw"],
                    ['lay01',                "⚡ lay 0x1"],
                    ['lay10',                "⚡ lay 1x0"],
                    ['lay00',                "🔵 lay 0x0"]
                ];

                for (const [flag, text] of orderedChecks) {
                    if (alertas[flag]) {
                        statuslinha = text;
                        break;
                    }
                }
            }
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
        '--js-flags=--max-old-space-size=150',
        '--disk-cache-size=1',
        '--media-cache-size=1',
        '--no-zygote',
        '--headless=new', // Garante o novo motor headless isolado
        '--disable-accelerated-2d-canvas',
        '--disable-features=VizDisplayCompositor',
        '--disable-background-timer-throttling',
        '--disable-renderer-backgrounding',
        '--disable-backgrounding-occluded-windows',
        '--disable-ipc-flooding-protection',
        '--disable-background-networking',
        '--disable-default-apps',
        '--disable-extensions'
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

    logger.registrarCallbackAdicionarJogo(async (urlValida) => {
        const idJogo_unico = String(urlValida.split('/').pop() || Date.now());
        if (poolDeJogos.has(idJogo_unico)) return {ok: false, erro: 'Jogo já iniciado'};
        try {
            const novaAba = await browser.newPage();
            // Desativar throttling via injeção e bloquear scripts/requests de terceiros
            try {
                // Forçar páginas em background a se comportarem como visíveis
                await novaAba.evaluateOnNewDocument(() => {
                    try {
                        Object.defineProperty(document, 'hidden', {get: () => false});
                        Object.defineProperty(document, 'visibilityState', {get: () => 'visible'});
                        // disparar eventos de visibilidade caso algum listener dependa disso
                        document.dispatchEvent(new Event('visibilitychange'));
                    } catch (e) {}
                });

                await novaAba.setRequestInterception(true);
                const thirdPartyPattern = /goog(le|analytics)|doubleclick|analytics|tracker|track|ads|adservice|cdn-cgi|facebook|pixel|hotjar|mixpanel|segment|amplitude/i;
                novaAba.on('request', req => {
                    const pt = req.resourceType();
                    const url = req.url();
                    try {
                        const u = new URL(url);
                        const hostname = u.hostname || '';

                        // Bloquear recursos pesados e scripts de terceiros conhecidos
                        const isWhitelisted = WHITELIST_HOSTNAMES.length > 0 && WHITELIST_HOSTNAMES.includes(hostname);
                        // Aggressive blocking for images/styles/fonts/media when not whitelisted
                        if (!isWhitelisted && ['image', 'stylesheet', 'font', 'media'].includes(pt)) {
                            if (DEBUG_BLOCKED) fs.appendFile('blocked_requests.log', `${new Date().toISOString()} ABORT ${pt} ${url}\n`, ()=>{});
                            return req.abort();
                        }

                        if (!isWhitelisted) {
                            if (pt === 'script' && (thirdPartyPattern.test(hostname) || thirdPartyPattern.test(url))) {
                                if (DEBUG_BLOCKED) fs.appendFile('blocked_requests.log', `${new Date().toISOString()} ABORT ${pt} ${url}\n`, ()=>{});
                                return req.abort();
                            }


                            if ((pt === 'xhr' || pt === 'fetch') && thirdPartyPattern.test(url)) {
                                if (DEBUG_BLOCKED) fs.appendFile('blocked_requests.log', `${new Date().toISOString()} ABORT ${pt} ${url}\n`, ()=>{});
                                return req.abort();
                            }
                        }

                        return req.continue();
                    } catch (e) {
                        return req.continue();
                    }
                });
            } catch (e) {
                // alguns ambientes podem não suportar intercept/evaluateOnNewDocument
            }
            await novaAba.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36');
            await novaAba.goto(urlValida, {waitUntil: 'domcontentloaded', timeout: GOTO_TIMEOUT_MS});

            try {
                const acceptSelectors = [
                    'button[aria-label*="accept"]', 'button[aria-label*="Aceitar"]', 'button[aria-label*="Aceitar tudo"]',
                    'button[class*="accept"]', 'button[class*="agree"]', 'button[class*="cookie"]', 'button[class*="consent"]',
                    '#onetrust-accept-btn-handler', '.onetrust-accept-btn-handler', '.gdpr-accept', '.cookie-consent button',
                    'button:contains("Aceitar")', 'button:contains("Accept")', 'button:contains("Concordo")'
                ];
                for (let sel of acceptSelectors) {
                    try {
                        // querySelector doesn't support :contains(...) — handle that case specially
                        const containsMatch = sel.match(/^button:contains\((?:"|')?(.*?)(?:"|')?\)$/i);
                        if (containsMatch) {
                            const text = containsMatch[1];
                            // find button by visible text
                            const found = await novaAba.evaluateHandle((txt) => {
                                const els = Array.from(document.querySelectorAll('button'));
                                for (const b of els) {
                                    if (b && b.textContent && b.textContent.trim().toLowerCase().includes(txt.toLowerCase())) return b;
                                }
                                return null;
                            }, text);
                            const element = found && (await found.asElement ? await found.asElement() : null);
                            if (element) {
                                await element.click();
                                await (novaAba.waitForTimeout ? novaAba.waitForTimeout(600) : new Promise(r => setTimeout(r, 600)));
                            }
                            try { if (found && typeof found.dispose === 'function') found.dispose(); } catch(_){}
                            continue;
                        }

                        const el = await novaAba.$(sel);
                        if (el) {
                            await novaAba.evaluate(s => {
                                const e = document.querySelector(s);
                                if (e) e.click();
                            }, sel);
                            await (novaAba.waitForTimeout ? novaAba.waitForTimeout(600) : new Promise(r => setTimeout(r, 600)));
                        }
                    } catch (e) { /* ignore per-selector errors */
                        console.warn(`[acceptSelectors] ${sel} erro: ${e}`);
                    }
                }
            } catch (e) { /* non-fatal */
                console.warn(`[acceptSelectors] erro: ${e}`);
            }

            // attach page-level diagnostics and heartbeat to keep watchdog happy
            try {
                const HEARTBEAT_MS = parseInt(process.env.HEARTBEAT_MS || '8000');
                const HEARTBEAT_FAILS = parseInt(process.env.HEARTBEAT_FAILS || '3');
                novaAba.on('console', msg => {
                    try {
                        const txt = msg.text ? msg.text() : String(msg);
                        // filter noisy preload/font warnings to reduce log spam
                        if (/was preloaded using link preload but not used/i.test(txt)) return;
                        process.stderr.write(`[PAGE_CONSOLE id=${idJogo_unico}] ${txt}\n`);
                    } catch(_){}
                });
                novaAba.on('pageerror', err => {
                    try { process.stderr.write(`[PAGE_ERROR id=${idJogo_unico}] ${err && err.stack ? err.stack : err}\n`); } catch(_){}
                });

                // heartbeat state
                let hbFails = 0;
                const hb = setInterval(async () => {
                    try {
                        await novaAba.evaluate(() => 1);
                        hbFails = 0;
                        const j = poolDeJogos.get(idJogo_unico);
                        if (j) j._ultimaAtualizacao = Date.now();
                    } catch (e) {
                        hbFails++;
                        process.stderr.write(`[HEARTBEAT] id=${idJogo_unico} falha #${hbFails} -> ${e && e.message ? e.message : e}\n`);
                        if (hbFails >= HEARTBEAT_FAILS) {
                            try {
                                process.stderr.write(`[HEARTBEAT] id=${idJogo_unico} excedeu falhas. Tentando recarregar...\n`);
                                await novaAba.reload({waitUntil: 'domcontentloaded', timeout: GOTO_TIMEOUT_MS});
                                hbFails = 0;
                                const j2 = poolDeJogos.get(idJogo_unico);
                                if (j2) j2._ultimaAtualizacao = Date.now();
                            } catch (e2) {
                                process.stderr.write(`[HEARTBEAT] reload falhou para id=${idJogo_unico} -> ${e2 && e2.message ? e2.message : e2}\n`);
                                try { clearInterval(hb); } catch(_){}
                                try { novaAba.close().catch(()=>{}); } catch(_){}
                            }
                        }
                    }
                }, HEARTBEAT_MS);

                // store heartbeat so graceful shutdown can clear it
                jogoHeartbeat = {interval: hb};
                // we'll attach the interval id into the page via the pool entry after creation below
            } catch (e) {}

            // marcar activity events para alimentar o watchdog (XHR/Fetch/requests)
            novaAba.on('requestfinished', req => {
                try {
                    const pt = req.resourceType();
                    if (['xhr', 'fetch', 'document', 'script', 'other'].includes(pt)) {
                        const jogoEntry = poolDeJogos.get(idJogo_unico);
                        if (jogoEntry) jogoEntry._ultimaAtualizacao = Date.now();
                    }
                } catch (e) {}
            });
            novaAba.on('response', res => {
                try {
                    const jogoEntry = poolDeJogos.get(idJogo_unico);
                    if (jogoEntry) jogoEntry._ultimaAtualizacao = Date.now();
                } catch (e) {}
            });
            novaAba.on('close', () => {
                try {
                    const maybe = poolDeJogos.get(idJogo_unico);
                    if (maybe && maybe._encerrando) {
                        process.stderr.write(`[PAGE] aba id=${idJogo_unico} fechada (encerrando)\n`);
                        return;
                    }
                } catch (e) {}
                process.stderr.write(`[PAGE] aba id=${idJogo_unico} fechada inesperadamente. Forçando restart.\n`);
                try { if (globalBrowser) globalBrowser.close().catch(()=>{}); } catch(e){}
                process.exit(1);
            });
            novaAba.on('error', err => {
                process.stderr.write(`[PAGE] erro na aba id=${idJogo_unico} -> ${err && err.message ? err.message : err}\n`);
            });

            poolDeJogos.set(idJogo_unico, {
                pageContext: novaAba,
                nomePartida: 'Carregando...',
                url: urlValida,
                _ultimaAtualizacao: Date.now(),
                _lastReload: Date.now(),
                _checksSinceReload: 0,
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

            // attach heartbeat interval reference into the pool entry if present
            try {
                const entry = poolDeJogos.get(idJogo_unico);
                if (entry && typeof jogoHeartbeat !== 'undefined' && jogoHeartbeat && jogoHeartbeat.interval) entry._heartbeat = jogoHeartbeat.interval;
            } catch (e) {}

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
                // Stagger checks per jogo to avoid picos quando há muitos jogos
                try {
                    const now = Date.now();
                    const perGameInterval = 10000; // mínimo entre checks por jogo (ms)
                    const jitter = jogo._jitter || (jogo._jitter = Math.floor(Math.random() * 3000));
                    if (jogo._lastCheck && (now - jogo._lastCheck) < (perGameInterval + jitter)) {
                        continue;
                    }
                    jogo._lastCheck = now;
                } catch (e) {}

                try {
                    // Watchdog: detectar inatividade silenciosa
                    try {
                        if (jogo._ultimaAtualizacao && (Date.now() - jogo._ultimaAtualizacao) > WATCHDOG_INATIVIDADE_MS) {
                            process.stderr.write(`[WATCHDOG] jogo id=${idJogo} sem atualizacao por mais de ${WATCHDOG_INATIVIDADE_MS}ms. Forçando reinicio.\n`);
                            // fechar browser e sair para que gerenciador reinicie
                            try { if (globalBrowser) await globalBrowser.close(); } catch (e) {}
                            process.exit(1);
                        }
                    } catch (e) {}
                    //
                    // reload periódico de segurança (anti-fome de socket)
                    try {
                        jogo._checksSinceReload = (jogo._checksSinceReload || 0) + 1;
                        if (!jogo._lastReload) jogo._lastReload = Date.now();
                        if ((Date.now() - jogo._lastReload) > RELOAD_INTERVAL_MS || jogo._checksSinceReload > 60) {
                            try {
                                jogo._checksSinceReload = 0;
                                jogo._lastReload = Date.now();
                                process.stdout.write(`[RELOAD] Recarrengando página id=${idJogo} por segurança.\n`);
                                await jogo.pageContext.reload({waitUntil: 'domcontentloaded', timeout: GOTO_TIMEOUT_MS});
                            } catch (e) {
                                process.stderr.write(`[RELOAD] falha ao recarregar id=${idJogo} -> ${e && e.message ? e.message : e}\n`);
                            }
                        }
                    } catch (e) {}
                    //
                    const dadosContexto = await safeEvaluateWithWatchdog(jogo, jogo.pageContext, () => {
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

                    // atualizar watchdog também se conseguimos extrair contexto de título/teams
                    try {
                        if (dadosContexto && (dadosContexto.timeCasa || dadosContexto.timeFora || dadosContexto.tituloAba)) {
                            jogo._ultimaAtualizacao = Date.now();
                        }
                    } catch (e) {}

                    const todosOsFrames = jogo.pageContext.frames();
                     let frameRadar = todosOsFrames.find(f =>
                         f.url().includes('radarfutebol.xyz/scoreboards') ||
                         f.name() === 'iframe-williamhill'
                     );

                     let contextoAlvo = frameRadar ? frameRadar : jogo.pageContext;

                    const r = await safeEvaluateWithWatchdog(jogo, contextoAlvo, () => {
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
                            const bodyText = (document.body && document.body.innerText) ? document.body.innerText.slice(0, 20000).toLowerCase() : '';
                            if (!statusEncerrado) {
                                if (/\bfinal\s*(da|de)?\s*partida\b/.test(bodyText) || /\bfim\s*(da|do|de)?\s*jogo\b/.test(bodyText) || bodyText.includes('resultado final') || bodyText.includes('apito final')) {
                                    statusEncerrado = true;
                                }
                            }
                        } catch (e) {
                        }

                        let noTexto = Array.from(document.querySelectorAll('div, span, p, b')).map(el => el.textContent ? el.textContent.trim() : '');
                        let matchPlacar = noTexto.find(t => /^\d+\s*-\s*\d+$/.test(t));
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
                        // atualização bem sucedida -> renovar watchdog timestamp
                        try { jogo._ultimaAtualizacao = Date.now(); } catch (e) {}
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

                            try {
                                const entry = poolDeJogos.get(idJogo) || jogo;
                                entry.momentum.ataquesCasa = 0;
                                entry.momentum.ataquesFora = 0;
                                entry.momentum.chutesNoAlvoCasa = 0;
                                entry.momentum.chutesParaForaCasa = 0;
                                entry.momentum.chutesNoAlvoFora = 0;
                                entry.momentum.chutesParaForaFora = 0;
                                entry.momentum.escanteiosCasa = 0;
                                entry.momentum.escanteiosFora = 0;
                                entry.posseBolaCasa = 0;
                                entry.posseBolaFora = 0;
                            } catch (e) { }

                            continue;
                        }

                        if (r.tempoLocal > 0 && r.tempoLocal >= jogo.tempo) jogo.tempo = r.tempoLocal;
                        if (r.placarLocal && r.placarLocal.includes('-')) jogo.placar = r.placarLocal;

                        let minAtual = jogo.tempo;

                        // limpar o histórico "micro 10m" a cada 10 minutos (para evitar crescimento indefinido)
                        try {
                            const entry = poolDeJogos.get(idJogo) || jogo;
                            const lastClear = entry._lastMomentumClear || 0;
                            if (minAtual > 0 && (minAtual % 10) === 0 && lastClear !== minAtual) {
                                entry.historicoAtqCasa = [];
                                entry.historicoAtqFora = [];
                                entry.historicoEscCasa = [];
                                entry.historicoEscFora = [];
                                entry.historicoChAlvoCasa = [];
                                entry.historicoChAlvoFora = [];
                                entry.historicoChForaCasa = [];
                                entry.historicoChForaFora = [];
                                entry._lastMomentumClear = minAtual;
                                process.stdout.write(`[MOMENTUM_CLEAR] id=${idJogo} limpou micro10m em ${minAtual}'\n`);
                            }
                        } catch (e) {}

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
                            // Feed aparenta ter sido reiniciado/ajustado (ex.: intervalo) —
                            // ressincroniza acumulados e zera o momentum + históricos para
                            // evitar que eventos do 1º tempo poluam o cálculo do 2º.
                            jogo.ataquesPerigososCasa = r.atqC;
                            jogo.ataquesPerigososFora = r.atqF;
                            jogo.escanteiosCasa = r.escC;
                            jogo.escanteiosFora = r.escF;
                            jogo.chutesNoAlvoCasa = r.chC;
                            jogo.chutesNoAlvoFora = r.chF;
                            jogo.chutesParaForaCasa = r.chForaC;
                            jogo.chutesParaForaFora = r.chForaF;

                            // limpar históricos que alimentam o momentum (micro10m)
                            jogo.historicoAtqCasa = [];
                            jogo.historicoAtqFora = [];
                            jogo.historicoEscCasa = [];
                            jogo.historicoEscFora = [];
                            jogo.historicoChAlvoCasa = [];
                            jogo.historicoChAlvoFora = [];
                            jogo.historicoChForaCasa = [];
                            jogo.historicoChForaFora = [];

                            // zerar momentum imediatamente
                            if (!jogo.momentum) jogo.momentum = {};
                            jogo.momentum.ataquesCasa = 0;
                            jogo.momentum.ataquesFora = 0;
                            jogo.momentum.escanteiosCasa = 0;
                            jogo.momentum.escanteiosFora = 0;
                            jogo.momentum.chutesNoAlvoCasa = 0;
                            jogo.momentum.chutesNoAlvoFora = 0;
                            jogo.momentum.chutesParaForaCasa = 0;
                            jogo.momentum.chutesParaForaFora = 0;

                            // debug: registrar ressincronização
                            try { process.stdout.write(`[RESYNC_FEED] id=${idJogo} ressincronizado e limpou históricos em ${minAtual}'\n`); } catch (e) {}
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
                // Desativar throttling via injeção e bloquear scripts/requests de terceiros
                try {
                    // Forçar páginas em background a se comportarem como visíveis
                    await novaAba.evaluateOnNewDocument(() => {
                        try {
                            Object.defineProperty(document, 'hidden', {get: () => false});
                            Object.defineProperty(document, 'visibilityState', {get: () => 'visible'});
                            // disparar eventos de visibilidade caso algum listener dependa disso
                            document.dispatchEvent(new Event('visibilitychange'));
                        } catch (e) {}
                        // reduzir timers agressivos (substituir setInterval / setTimeout não recomendado globalmente)
                    });

                    await novaAba.setRequestInterception(true);
                    const thirdPartyPattern = /goog(le|analytics)|doubleclick|analytics|tracker|track|ads|adservice|cdn-cgi|facebook|pixel|hotjar|mixpanel|segment|amplitude/i;
                    const allowedHostnames = [];
                    novaAba.on('request', req => {
                        const pt = req.resourceType();
                        const url = req.url();
                        try {
                            const u = new URL(url);
                            const hostname = u.hostname || '';

                            // Bloquear recursos pesados e scripts de terceiros conhecidos
                            const isWhitelisted = WHITELIST_HOSTNAMES.length > 0 && WHITELIST_HOSTNAMES.includes(hostname);
                            if (!isWhitelisted && ['image', 'stylesheet', 'font', 'media'].includes(pt)) {
                                if (DEBUG_BLOCKED) fs.appendFile('blocked_requests.log', `${new Date().toISOString()} ABORT ${pt} ${url}\n`, ()=>{});
                                return req.abort();
                            }
                            if (!isWhitelisted) {
                                if (pt === 'script' && (thirdPartyPattern.test(hostname) || thirdPartyPattern.test(url))) {
                                    if (DEBUG_BLOCKED) fs.appendFile('blocked_requests.log', `${new Date().toISOString()} ABORT ${pt} ${url}\n`, ()=>{});
                                    return req.abort();
                                }
                                // Bloquear analytics/collect endpoints mesmo que sejam XHR/fetch
                                if ((pt === 'xhr' || pt === 'fetch') && thirdPartyPattern.test(url)) {
                                    if (DEBUG_BLOCKED) fs.appendFile('blocked_requests.log', `${new Date().toISOString()} ABORT ${pt} ${url}\n`, ()=>{});
                                    return req.abort();
                                }
                            }

                            // permitir o resto
                            return req.continue();
                        } catch (e) {
                            return req.continue();
                        }
                    });
                } catch (e) {
                    // alguns ambientes podem não suportar intercept/evaluateOnNewDocument
                }
                await novaAba.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36');
                await novaAba.goto(urlValida, {waitUntil: 'domcontentloaded', timeout: GOTO_TIMEOUT_MS});

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
                                await (novaAba.waitForTimeout ? novaAba.waitForTimeout(600) : new Promise(r => setTimeout(r, 600)));
                            }
                        } catch (e) { /* ignore per-selector errors */
                        }
                    }
                } catch (e) { /* non-fatal */
                }
                // attach diagnostics and heartbeat for prompt-created pages
                try {
                    const HEARTBEAT_MS = parseInt(process.env.HEARTBEAT_MS || '8000');
                    const HEARTBEAT_FAILS = parseInt(process.env.HEARTBEAT_FAILS || '3');
                    novaAba.on('console', msg => { try{ const t = msg.text ? msg.text() : String(msg); if (!/was preloaded using link preload but not used/i.test(t)) process.stderr.write(`[PAGE_CONSOLE id=${idJogo_unico}] ${t}\n`); }catch(_){} });
                    novaAba.on('pageerror', err => { try{ process.stderr.write(`[PAGE_ERROR id=${idJogo_unico}] ${err && err.stack ? err.stack : err}\n`); }catch(_){} });

                    let hbFails = 0;
                    const hb = setInterval(async () => {
                        try {
                            await novaAba.evaluate(() => 1);
                            hbFails = 0;
                            const j = poolDeJogos.get(idJogo_unico);
                            if (j) j._ultimaAtualizacao = Date.now();
                        } catch (e) {
                            hbFails++;
                            process.stderr.write(`[HEARTBEAT] id=${idJogo_unico} falha #${hbFails} -> ${e && e.message ? e.message : e}\n`);
                            if (hbFails >= HEARTBEAT_FAILS) {
                                try {
                                    process.stderr.write(`[HEARTBEAT] id=${idJogo_unico} excedeu falhas. Tentando recarregar...\n`);
                                    await novaAba.reload({waitUntil: 'domcontentloaded', timeout: GOTO_TIMEOUT_MS});
                                    hbFails = 0;
                                    const j2 = poolDeJogos.get(idJogo_unico);
                                    if (j2) j2._ultimaAtualizacao = Date.now();
                                } catch (e2) {
                                    process.stderr.write(`[HEARTBEAT] reload falhou para id=${idJogo_unico} -> ${e2 && e2.message ? e2.message : e2}\n`);
                                    try { clearInterval(hb); } catch(_){}
                                    try { novaAba.close().catch(()=>{}); } catch(_){}
                                }
                            }
                        }
                    }, HEARTBEAT_MS);

                    // store into temporary so we can attach after pool set
                    jogoHeartbeat = {interval: hb};
                } catch (e) {}
                poolDeJogos.set(idJogo_unico, {
                    pageContext: novaAba,
                    nomePartida: 'Carregando...',
                    // URL original usada para iniciar o scanner (prompt flow)
                    url: urlValida,
                    _ultimaAtualizacao: Date.now(),
                    _lastReload: Date.now(),
                    _checksSinceReload: 0,
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

                // attach heartbeat interval reference into the pool entry if present
                try {
                    const entry = poolDeJogos.get(idJogo_unico);
                    if (entry && typeof jogoHeartbeat !== 'undefined' && jogoHeartbeat && jogoHeartbeat.interval) entry._heartbeat = jogoHeartbeat.interval;
                } catch (e) {}

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
                    // clear heartbeat interval if present
                    try { if (jogo._heartbeat) clearInterval(jogo._heartbeat); } catch(_) {}
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



