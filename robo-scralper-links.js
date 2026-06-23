// debug_inspect_radar.js
// Load environment variables from .env for local configuration
try { require('dotenv').config(); } catch(e) { /* dotenv optional */ }
const puppeteer = require('puppeteer');
const http = require('http');
const fs = require('fs');
const path = require('path');
const PROCESSED_FILE = path.join(__dirname, 'processed.json');

// Configuration
const HEADLESS = true; // set false for debugging
const CYCLE_DELAY = 60000;
const CLICK_DELAY = 5000;


// load persisted processed ids
function loadProcessed() {
    try {
        if (fs.existsSync(PROCESSED_FILE)) {
            const txt = fs.readFileSync(PROCESSED_FILE, 'utf8');
            const arr = JSON.parse(txt || '[]');
            return new Set(arr);
        }
    } catch (e) { console.warn('[Scout] Não foi possível ler processed.json:', e.message || e); }
    return new Set();
}

function saveProcessedSet(set) {
    try {
        const arr = Array.from(set);
        fs.writeFileSync(PROCESSED_FILE, JSON.stringify(arr), 'utf8');
    } catch (e) { console.warn('[Scout] Erro ao salvar processed.json:', e.message || e); }
}

async function rodarMinerador() {
    console.log('[Scout] Iniciando Robô Sentinela...');
    const browser = await puppeteer.launch({ headless: HEADLESS, args: ['--no-sandbox'] });
    const page = await browser.newPage();
    // helper to close/remove cookie/privacy banners that may block the UI
    async function closePrivacyModal(pg) {
        try {
            await pg.evaluate(() => {
                try {
                    // common button texts to look for (Portuguese & English)
                    const texts = ['aceitar', 'aceito', 'entendi', 'fechar', 'ok', 'aceitar tudo', 'accept', 'close', 'got it'];

                    // 1) try some common selectors
                    const selCandidates = [
                        'button[aria-label*="aceitar" i]',
                        'button[aria-label*="accept" i]',
                        'button[class*="cookie" i]',
                        'button[class*="accept" i]',
                        'button[data-role="accept"]',
                        'button[data-role="all"]',
                        'div.cookie-banner button',
                        'div.cookie-consent button'
                    ];
                    for (const s of selCandidates) {
                        try {
                            const el = document.querySelector(s);
                            if (el) { el.click(); return; }
                        } catch(e){}
                    }

                    // 2) scan all buttons for matching innerText
                    const buttons = Array.from(document.querySelectorAll('button'));
                    for (const b of buttons) {
                        try {
                            const t = (b.innerText || '').toLowerCase().trim();
                            if (!t) continue;
                            for (const m of texts) if (t.includes(m)) { try { b.click(); } catch(e){}; return; }
                        } catch(e){}
                    }

                    // 3) fallback: remove elements containing privacy/cookie text
                    const candidates = Array.from(document.querySelectorAll('div,section'));
                    for (const node of candidates) {
                        try {
                            const txt = (node.innerText || '').toLowerCase();
                            if (txt.includes('privacidade') || txt.includes('cookies') || txt.includes('sua privacidade') || txt.includes('cookie')) {
                                node.parentElement && node.parentElement.removeChild(node);
                                return;
                            }
                        } catch(e){}
                    }
                } catch(e){}
            });
            // small wait for UI to reflect changes
            await new Promise(r => setTimeout(r, 250));
        } catch (e) {
            // ignore errors closing privacy modal
        }
    }

    // use global loaded set if present so exit handler saves the same set
    const processados = processadosGlobal || loadProcessed();
    processadosGlobal = processados;
    // in-memory set to track items currently being processed in this run
    const inProgress = new Set();

    // Inject navigational interceptors before any script runs
    await page.evaluateOnNewDocument(() => {
        (function() {
            window.__lastOpenedUrl = null;
            const _open = window.open;
            window.open = function(url, name, specs) {
                try { window.__lastOpenedUrl = typeof url === 'string' ? url : (url && url.toString()); } catch(e){}
                return _open.call(this, url, name, specs);
            };

            const wrap = (owner, name) => {
                try {
                    const orig = owner[name];
                    owner[name] = function() {
                        try { const url = arguments[2] || arguments[0]; if (typeof url === 'string') window.__lastOpenedUrl = url; } catch(e){}
                        return orig.apply(this, arguments);
                    };
                } catch(e){}
            };

            try { wrap(history, 'pushState'); wrap(history, 'replaceState'); } catch(e){}

            try {
                const assignOrig = location.assign.bind(location);
                location.assign = function(url) { try { window.__lastOpenedUrl = url; } catch(e){}; return assignOrig(url); };
            } catch(e){}
            try {
                const replaceOrig = location.replace.bind(location);
                location.replace = function(url) { try { window.__lastOpenedUrl = url; } catch(e){}; return replaceOrig(url); };
            } catch(e){}

            try {
                const loc = window.location;
                const proto = Object.getPrototypeOf(loc);
                const desc = Object.getOwnPropertyDescriptor(proto, 'href');
                if (desc && desc.set) {
                    const originalSetter = desc.set;
                    Object.defineProperty(loc, 'href', {
                        set: function(v) { try { window.__lastOpenedUrl = v; } catch(e){}; return originalSetter.call(this, v); },
                        get: function() { return desc.get.call(this); },
                        configurable: true
                    });
                }
            } catch(e){}
        })();
    });

    // Network listener to capture radar URLs from API responses
    let lastMatchedUrl = null;
    // recentDetections to debounce repeated URL detections: url -> ts
    const recentDetections = new Map();
    page.on('response', async (res) => {
        try {
            const url = res.url();
            if (!/radar|game|match|partida|jogo/i.test(url)) return;
            const ct = (res.headers() && res.headers()['content-type']) || '';
            if (!/json|text|html|application/i.test(ct) && !url.includes('/radar')) return;
            const text = await res.text().catch(() => null);
            if (!text) return;
            if (text.toLowerCase().includes('radar') || /\/radar\//i.test(text)) {
                // find absolute or relative radar url
                const m = text.match(/https?:\/\/[^"]*radar[^"\s]*/i) || text.match(/\/radar\/[^"'\s\}\]]+/i);
                if (m) {
                    lastMatchedUrl = m[0];
                    console.log('[Scout][NET] Captured radar URL from response:', lastMatchedUrl);
                }
            }
        } catch (e) {
            // ignore
        }
    });

    await page.goto('https://www.radarfutebol.com/', { waitUntil: 'networkidle2' });
    // try to close privacy/cookies banner right after navigation
    await closePrivacyModal(page).catch(()=>{});

    // Configurações iniciais (Cookies e Ao Vivo)
    await page.evaluate(() => {
        const btn = document.querySelector('button[data-role="all"]');
        if (btn) btn.click();
        const liveBtn = Array.from(document.querySelectorAll('button')).find(b => b.innerText?.toUpperCase().includes('AO VIVO'));
        if (liveBtn) liveBtn.click();
    });

    await new Promise(r => setTimeout(r, 5000));

    // util: try to extract url from element using dataset, anchor, or Vue props
    async function extractUrlFromElement(elHandle) {
        return await elHandle.evaluate(el => {
            try {
                // data-* attributes
                if (el.dataset) {
                    const keys = ['href','url','link'];
                    for (const k of keys) if (el.dataset[k]) return el.dataset[k];
                }
                // anchor inside
                const a = el.querySelector && el.querySelector('a');
                if (a && a.href) return a.href;
                // Vue 3
                if (el.__vueParentComponent && el.__vueParentComponent.vnode && el.__vueParentComponent.vnode.props) {
                    const p = el.__vueParentComponent.vnode.props;
                    if (p.url) return p.url; if (p.href) return p.href;
                }
                // Vue 2
                if (el.__vue__) {
                    const p = el.__vue__.$props || el.__vue__.$options;
                    if (p && (p.url || p.href)) return p.url || p.href;
                }
                // try walking up
                let pnode = el;
                for (let depth=0; depth<6 && pnode; depth++) {
                    const v = pnode.__vueParentComponent || pnode.__vue__;
                    if (v && v.props) { if (v.props.url) return v.props.url; if (v.props.href) return v.props.href; }
                    pnode = pnode.parentElement;
                }
            } catch(e){}
            return null;
        });
    }

    // 2. LOOP DE MONITORAMENTO (Sem recarregar)
    while (true) {
        try {
            console.log(`[${new Date().toLocaleTimeString()}] Monitorando grade existente...`);

            // Re-apply "Ao Vivo" filter each cycle to ensure new games are shown
            try {
                await page.evaluate(() => {
                    const btn = document.querySelector('button[data-role="all"]');
                    if (btn) btn.click();
                    const liveBtn = Array.from(document.querySelectorAll('button')).find(b => b.innerText?.toUpperCase().includes('AO VIVO'));
                    if (liveBtn) liveBtn.click();
                });
                // small wait for UI to update
                await new Promise(r => setTimeout(r, 1000));
            } catch (e) {
                // ignore
            }

            const radarElements = await page.$$('tbody tr .radar');
            const totalRadares = radarElements.length;
            console.log(`[Scout] Radares ativos na grade: ${totalRadares}`);

            // iterate by always picking the first available .radar element and re-querying
            let processedThisCycle = 0;
            let i = 0;
            while (true) {
                try {
                    const elementsNow = await page.$$('tbody tr .radar');
                    if (!elementsNow || elementsNow.length === 0) break;
                    const el = elementsNow[0];
                    if (!el) break;

                    // 1) try to extract URL directly
                    let urlFinal = await extractUrlFromElement(el);

                        // If we can extract an ID and it's already processed, skip and remove element
                        try {
                            if (urlFinal) {
                                // we only consider the full normalized URL as the source of truth
                                if (processados.has(urlFinal)) {
                                    await el.evaluate(node => node.setAttribute('data-processed','1'));
                                    await el.evaluate(node => { const tr = node.closest('tr'); if (tr) tr.remove(); });
                                    continue;
                                }
                            } else {
                                // try to infer an id from the DOM even if url not available yet (anchor href or data attributes)
                                const inferred = await el.evaluate(node => {
                                    try {
                                        const a = node.closest('tr') && node.closest('tr').querySelector('a');
                                        if (a && a.href) return a.href.split('/').pop();
                                        if (node.dataset) {
                                            if (node.dataset.id) return node.dataset.id;
                                            if (node.dataset.href) return node.dataset.href.split('/').pop();
                                        }
                                    } catch(e){}
                                    return null;
                                }).catch(() => null);
                                // If we only inferred an id/href fragment we cannot reliably match against the
                                // saved processed full-URLs. Skip only if the exact inferred value is present
                                // as a full URL in the processed set (rare). Otherwise, allow clicking to
                                // resolve the full URL and then check against the saved links.
                                if (inferred && processados.has(inferred)) {
                                    await el.evaluate(node => node.setAttribute('data-processed','1'));
                                    await el.evaluate(node => { const tr = node.closest('tr'); if (tr) { tr.remove(); return; } const container = node.closest('div.shadow.overflow-hidden'); if (container) container.remove(); });
                                    continue;
                                }
                            }
                        } catch(e) {}
                    // 2) if not found, click and rely on interceptors / network
                    if (!urlFinal) {
                        const newPagePromise = new Promise(resolve => browser.once('targetcreated', target => resolve(target.page())));

                        // clear lastMatchedUrl before action
                        lastMatchedUrl = null;

                        // capture current pages then click; we'll close any new pages opened by the click
                        const pagesBefore = await browser.pages();
                        const idsBefore = pagesBefore.map(p => p.target()._targetId);

                        // try to infer id before clicking to avoid duplicate processing
                        const inferredBefore = await el.evaluate(node => {
                            try {
                                const a = node.closest('tr') && node.closest('tr').querySelector('a');
                                if (a && a.href) return a.href.split('/').pop();
                                if (node.dataset) { if (node.dataset.id) return node.dataset.id; if (node.dataset.href) return node.dataset.href.split('/').pop(); }
                            } catch(e){}
                            return null;
                        }).catch(() => null);
                        // Use full URL as the key for in-progress/processed checks. If we only have an
                        // inferred id we can't reliably decide, so we avoid skipping based solely on id.
                        if (inferredBefore && inProgress.has(inferredBefore)) {
                            // already processed or in-progress, skip
                            await el.evaluate(node => node.setAttribute('data-processed','1')).catch(() => {});
                            await el.evaluate(node => { const tr = node.closest('tr'); if (tr) tr.remove(); }).catch(() => {});
                            continue;
                        }

                        // mark as processing to avoid other iterations clicking same element
                        await el.evaluate(node => node.setAttribute('data-processing','1')).catch(() => {});
                        // prepare to capture any newly opened page quickly and abort its requests to avoid full load (prevents 403 from radar)
                        let capturedFromNewPage = null;
                        const targetListener = async (target) => {
                            try {
                                const p = await target.page();
                                if (!p) return;
                                // enable interception to abort requests rapidly
                                try { await p.setRequestInterception(true); } catch(e){}
                                 // ensure we only handle each intercepted request once to avoid "Request is already handled" errors
                                  const _handledRequests = new WeakSet();
                                  p.on('request', req => {
                                      try {
                                          if (_handledRequests.has(req)) return;
                                          _handledRequests.add(req);
                                          // best-effort: abort most requests to avoid full page load; do not call continue after abort
                                          try {
                                              req.abort();
                                          } catch (abortErr) {
                                              // if abort fails, attempt continue as fallback
                                              try { req.continue(); } catch(_) {}
                                          }
                                      } catch(e) {
                                          // final fallback: attempt to continue to avoid leaving request unhandled
                                          try { req.continue(); } catch(_) {}
                                      }
                                  });

                                // wait shortly for navigation / domcontent to settle, then grab url
                                try {
                                    await Promise.race([
                                        p.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 3000 }).catch(() => {}),
                                        new Promise(r => setTimeout(r, 1500))
                                    ]);
                                } catch(e){}
                                try { const u = p.url(); if (u) capturedFromNewPage = u; } catch(e){}
                                try { await p.close(); } catch(e){}
                            } catch(e){}
                        };
                        browser.once('targetcreated', targetListener);
                        // perform the click: click the `.radar` element center to ensure we trigger the radar action
                        const box = await el.boundingBox();
                        if (box) {
                            await page.mouse.click(box.x + box.width/2, box.y + box.height/2);
                        } else {
                            // last resort: dispatch click on the element
                            await el.evaluate(node => { try { node.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window })); } catch(e){} });
                        }

                        // wait a bit for network intercepts to capture URLs
                        await new Promise(r => setTimeout(r, CLICK_DELAY));
                        // remove listener if it wasn't triggered
                        try { browser.removeListener('targetcreated', targetListener); } catch(e){}
                        if (capturedFromNewPage) lastMatchedUrl = lastMatchedUrl || capturedFromNewPage;

                        // try to read any intercepted values exposed in page (window.__lastOpenedUrl)
                        try {
                            const winLast = await page.evaluate(() => { try { return window.__lastOpenedUrl || null; } catch(e) { return null; } });
                            if (winLast) lastMatchedUrl = lastMatchedUrl || winLast;
                        } catch(e) {}

                        // if network/interceptors captured a URL, use it
                        if (lastMatchedUrl) {
                            urlFinal = lastMatchedUrl;
                        }
                    }

                    if (!urlFinal) {
                        try {
                            // collect diagnostic info to help debug why extraction failed
                            const diag = { outer: null, rowHtml: null, bbox: null, lastMatchedUrl: lastMatchedUrl };
                            try {
                                diag.outer = await el.evaluate(node => node.outerHTML).catch(() => null);
                                diag.rowHtml = await el.evaluate(node => { const tr = node.closest('tr'); return tr ? tr.innerHTML : null; }).catch(() => null);
                                const b = await el.boundingBox(); if (b) diag.bbox = { x: b.x, y: b.y, width: b.width, height: b.height };
                            } catch(e){}
                            // try to read injected window.__lastOpenedUrl if available
                            try {
                                const lastOpen = await page.evaluate(() => { try { return window.__lastOpenedUrl || null; } catch(e) { return null; } });
                                if (lastOpen) diag.windowLastOpened = lastOpen;
                            } catch(e){}

                            const ts = Date.now();
                            console.warn(`[Scout] Não foi possível obter URL do radar para o jogo na posição ${i}. Diagnostic:`, diag);
                            // save a small screenshot to help visual debugging (if possible)
                            try {
                                const screenshotsDir = path.join(__dirname, 'log', 'telemetria');
                                if (!fs.existsSync(screenshotsDir)) fs.mkdirSync(screenshotsDir, { recursive: true });
                                const file = path.join(screenshotsDir, `inspect_radar_pos_${i}_${ts}.png`);
                                // ensure privacy/cookie banner closed before screenshot
                                try { await closePrivacyModal(page); } catch(_){}
                                // if we have bbox, clip to element area, otherwise full page
                                if (diag.bbox) {
                                    await page.screenshot({ path: file, clip: { x: Math.max(0, diag.bbox.x), y: Math.max(0, diag.bbox.y), width: Math.min(diag.bbox.width, 2000), height: Math.min(diag.bbox.height, 2000) } }).catch(() => {});
                                } else {
                                    await page.screenshot({ path: file, fullPage: false }).catch(() => {});
                                }
                                console.log('[Scout] Screenshot salva em', file);
                            } catch(e) { console.warn('[Scout] Falha ao salvar screenshot de diagnóstico:', e && e.message ? e.message : e); }
                        } catch (e) {
                            console.warn('[Scout] Erro ao coletar diagnósticos:', e && e.message ? e.message : e);
                        }
                        continue;
                    }

                    // Normalize URL: if relative path (starts with '/'), prefix site origin
                    try {
                        if (/^\//.test(urlFinal)) {
                            urlFinal = new URL(urlFinal, 'https://www.radarfutebol.com').toString();
                        }
                        // strip surrounding quotes if any
                        urlFinal = urlFinal.replace(/^"|"$/g, '').trim();
                        // remove querystring or fragment and trailing slash to obtain stable id
                        urlFinal = urlFinal.replace(/[?#].*$/, '').replace(/\/$/, '');
                    } catch (e) {
                        console.warn('[Scout] Erro ao normalizar URL:', urlFinal, e.message || e);
                    }

                    // debounce: if we detected the same normalized URL very recently, skip noisy logs
                    const now = Date.now();
                    const normUrlKey = urlFinal;
                    const lastTs = recentDetections.get(normUrlKey) || 0;
                    if (now - lastTs < 10_000) {
                        // update timestamp to extend suppression window and skip noisy processing
                        recentDetections.set(normUrlKey, now);
                        console.log('[Scout] Debounced repeated detection for', urlFinal);
                        continue;
                    }
                    recentDetections.set(normUrlKey, now);
                    // cleanup old entries periodically
                    if (recentDetections.size > 500) {
                        const cutoff = now - 60_000;
                        for (const [k, v] of recentDetections.entries()) if (v < cutoff) recentDetections.delete(k);
                    }

                    console.log('[Scout] URL final detectada:', urlFinal);

                    const jogoId = urlFinal.split('/').pop();
                    // If the processed list may contain either ids or full URLs,
                    // consider both forms when deciding to skip/remove the button.
                    if (processados.has(jogoId) || processados.has(urlFinal) || inProgress.has(jogoId) || inProgress.has(urlFinal)) {
                        // mark as processed in DOM and remove to avoid re-clicks
                        try {
                            await el.evaluate(node => node.setAttribute('data-processed','1'));
                            await el.evaluate(node => { const tr = node.closest('tr'); if (tr) { tr.remove(); return; } const container = node.closest('div.shadow.overflow-hidden'); if (container) container.remove(); }).catch(() => {});
                        } catch(e) {}
                        // skip further processing for this item
                        console.log('[Scout] Skipping already-processed/in-progress jogoId=', jogoId);
                    } else if (!processados.has(jogoId)) {
                        try {
                            // mark as in-progress using the full URL to avoid collisions by id
                            inProgress.add(urlFinal);
                            const sendResult = await sendToServer(urlFinal);
                            if (sendResult && sendResult.ok) {
                                console.log(`✅ [SUCESSO] Jogo ${jogoId} enviado.`);
                                // persist only the normalized full URL as the canonical processed key
                                try { processados.add(urlFinal); } catch(_){ }
                                // persist immediately
                                try { saveProcessedSet(processados); } catch(e) { console.warn('Erro salvando processados:', e.message||e); }
                                // mark in DOM as processed and remove
                                await el.evaluate(node => node.setAttribute('data-processed','1'));
                                await el.evaluate(node => {
                                    const tr = node.closest('tr'); if (tr) { tr.remove(); return; }
                                    const container = node.closest('div.shadow.overflow-hidden'); if (container) container.remove();
                                }).catch(() => {});
                                // fallback cleanup: remove any rows/anchors that reference this jogoId
                                try {
                                    await page.evaluate((id) => {
                                        try {
                                            const anchors = Array.from(document.querySelectorAll('a')).filter(a => a.href && a.href.includes(id));
                                            for (const a of anchors) { const tr = a.closest('tr'); if (tr) tr.remove(); }
                                            const radares = Array.from(document.querySelectorAll('.radar[data-processing]'));
                                            for (const r of radares) { const tr = r.closest('tr'); if (tr) tr.remove(); }
                                        } catch(e){}
                                    }, jogoId);
                                } catch(e) {}
                                inProgress.delete(urlFinal);
                            } else {
                                // If server indicates game already started/exists, mark as processed to avoid retries
                                let handled = false;
                                try {
                                    if (sendResult && sendResult.status) {
                                        const st = sendResult.status;
                                        const body = sendResult.body;
                                        if (st === 409 && typeof body === 'string') {
                                            const js = JSON.parse(body);
                                            if (js && js.erro && /Jogo já iniciado/i.test(js.erro)) {
                                                console.log(`[Scout] Servidor diz que o jogo já iniciou para ${jogoId}, marcando como processado.`);
                                                // mark the normalized full URL as processed to avoid retries
                                                try { processados.add(urlFinal); } catch(_){ }
                                                try { saveProcessedSet(processados); } catch(e){}
                                                await el.evaluate(node => node.setAttribute('data-processed','1'));
                                                await el.evaluate(node => { const tr = node.closest('tr'); if (tr) { tr.remove(); return; } const container = node.closest('div.shadow.overflow-hidden'); if (container) container.remove(); });
                                                handled = true;
                                            }
                                        }
                                    }
                                } catch(e) {}
                                if (!handled) console.warn('[Scout] Falha ao enviar para o servidor', sendResult);
                            }
                        } catch (e) {
                            console.warn('[Scout] Erro ao enviar jogo:', e.message || e);
                            try { inProgress.delete(jogoId); } catch(_){}
                        }
                    }

                    // small delay between items (avoid too-frequent clicks)
                    await new Promise(r => setTimeout(r, CLICK_DELAY));
                    processedThisCycle++;
                    i++;
                } catch (e) {
                    console.error('Erro interno no loop de radares:', e.message || e);
                    break;
                }
            }

            // Finalize: persist processed set, close browser and exit the miner so the process stops
            try { saveProcessedSet(processados); } catch(e) { console.warn('[Scout] Erro salvando processados antes de sair:', e && e.message ? e.message : e); }
            try { console.log('Finalizando Robo.');await browser.close(); } catch(e) { /* ignore close errors */ }
            return; // exit rodarMinerador so script terminates instead of looping
        } catch (e) {
            console.error('Erro crítico:', e.message || e);
            try { await page.reload(); } catch(e){}
        }
    }
}

// ensure processed saved on exit
process.on('SIGINT', () => {
    try { saveProcessedSet(processadosGlobal); } catch(e){}
    process.exit(0);
});
process.on('SIGTERM', () => {
    try { saveProcessedSet(processadosGlobal); } catch(e){}
    process.exit(0);
});

// Keep a global ref for exit handler
let processadosGlobal = null;

(async () => {
    processadosGlobal = loadProcessed();
    // start main miner but reuse the loaded set
    await rodarMinerador();
})();

// sendToServer now respects API_BASE environment variable so we can point to a public API in production
async function sendToServer(urlToSend) {
    // Retry loop for transient 503 "Engine ainda não pronta" from local server
    const maxAttempts = 5;
    const baseDelay = 1500; // ms
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
            const data = JSON.stringify({ url: urlToSend });
            const apiBase = process.env.API_BASE || process.env.API_URL || 'http://127.0.0.1:3000';
            const apiUrl = new URL('/add-game', apiBase);
            const options = {
                hostname: apiUrl.hostname,
                port: apiUrl.port || (apiUrl.protocol === 'https:' ? 443 : 80),
                path: apiUrl.pathname + (apiUrl.search || ''),
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Content-Length': Buffer.byteLength(data)
                },
                timeout: 5000
            };
            const result = await new Promise((resolve) => {
                const req = http.request(options, (res) => {
                    let body = '';
                    res.on('data', (chunk) => body += chunk);
                    res.on('end', () => {
                        resolve({ ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode, body });
                    });
                });
                req.on('error', (err) => resolve({ ok: false, error: err.message }));
                req.on('timeout', () => { req.destroy(); resolve({ ok: false, error: 'timeout' }); });
                req.write(data);
                req.end();
            });

            // If server says engine not ready (503), retry with backoff
            if (result && result.status === 503 && typeof result.body === 'string' && result.body.includes('Engine ainda não pronta')) {
                if (attempt < maxAttempts) {
                    const wait = baseDelay * attempt;
                    console.log(`[Scout] Servidor ainda inicializando (attempt ${attempt}/${maxAttempts}), aguardando ${wait}ms antes de tentar novamente`);
                    await new Promise(r => setTimeout(r, wait));
                    continue; // retry
                }
            }
            return result;
        } catch (e) {
            // transient error: retry unless last attempt
            if (attempt < maxAttempts) {
                const wait = baseDelay * attempt;
                console.log(`[Scout] Erro ao conectar ao servidor (attempt ${attempt}/${maxAttempts}): ${e.message || e} — aguardando ${wait}ms`);
                await new Promise(r => setTimeout(r, wait));
                continue;
            }
            return { ok: false, error: e.message || String(e) };
        }
    }
    return { ok: false, error: 'max_attempts_exceeded' };
 }
