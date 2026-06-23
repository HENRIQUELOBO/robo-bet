try {
    require('dotenv').config();
} catch (_) {
}
const puppeteer = require('puppeteer');
const http = require('http');
const fs = require('fs');
const path = require('path');
const PROCESSED_FILE = path.join(__dirname, 'processed.json');
const HEADLESS = true;
const CLICK_DELAY = 1500;
let globalBrowser = null;

function loadProcessed() {
    try {
        if (fs.existsSync(PROCESSED_FILE)) {
            const txt = fs.readFileSync(PROCESSED_FILE, 'utf8');
            const arr = JSON.parse(txt || '[]');
            return new Set(arr);
        }
    } catch (e) {
        console.warn('[Scout] Não foi possível ler processed.json:', e.message || e);
    }
    return new Set();
}

let _pendingProcessedSave = null;

function saveProcessedSet(set) {
    try {
        if (_pendingProcessedSave) clearTimeout(_pendingProcessedSave);
        _pendingProcessedSave = setTimeout(() => {
            try {
                const arr = Array.from(set);
                fs.writeFile(PROCESSED_FILE, JSON.stringify(arr), 'utf8', (err) => {
                    if (err) console.warn('[Scout] Erro ao salvar processed.json (async):', err.message || err);
                });
            } catch (e) {
                console.warn('[Scout] Erro ao salvar processed.json (async):', e.message || e);
            }
            _pendingProcessedSave = null;
        }, 1000);
    } catch (e) {
        console.warn('[Scout] Erro agendando save de processed.json:', e.message || e);
    }
}

async function rodarMinerador() {
    console.log('[Scout] Iniciando Robô Sentinela...');
    const browser = await puppeteer.launch({headless: HEADLESS, args: ['--no-sandbox']});
    globalBrowser = browser;
    const page = await browser.newPage();

    async function closePrivacyModal(pg) {
        try {
            await pg.evaluate(() => {
                try {
                    const texts = ['aceitar', 'aceito', 'entendi', 'fechar', 'ok', 'aceitar tudo', 'accept', 'close', 'got it'];
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
                            if (el) {
                                el.click();
                                return;
                            }
                        } catch (e) {
                        }
                    }
                    const buttons = Array.from(document.querySelectorAll('button'));
                    for (const b of buttons) {
                        try {
                            const t = (b.innerText || '').toLowerCase().trim();
                            if (!t) continue;
                            for (const m of texts) if (t.includes(m)) {
                                try {
                                    b.click();
                                } catch (e) {
                                }
                                ;
                                return;
                            }
                        } catch (e) {
                        }
                    }
                    const candidates = Array.from(document.querySelectorAll('div,section'));
                    for (const node of candidates) {
                        try {
                            const txt = (node.innerText || '').toLowerCase();
                            if (txt.includes('privacidade') || txt.includes('cookies') || txt.includes('sua privacidade') || txt.includes('cookie')) {
                                node.parentElement && node.parentElement.removeChild(node);
                                return;
                            }
                        } catch (e) {
                        }
                    }
                } catch (e) {
                }
            });
            await new Promise(r => setTimeout(r, 250));
        } catch (e) {
        }
    }

    const processados = processadosGlobal || loadProcessed();
    processadosGlobal = processados;
    const inProgress = new Set();

    await page.evaluateOnNewDocument(() => {
        (function () {
            window.__lastOpenedUrl = null;
            const _open = window.open;
            window.open = function (url, name, specs) {
                try {
                    window.__lastOpenedUrl = typeof url === 'string' ? url : (url && url.toString());
                } catch (e) {
                }
                return _open.call(this, url, name, specs);
            };
            const wrap = (owner, name) => {
                try {
                    const orig = owner[name];
                    owner[name] = function () {
                        try {
                            const url = arguments[2] || arguments[0];
                            if (typeof url === 'string') window.__lastOpenedUrl = url;
                        } catch (e) {
                        }
                        return orig.apply(this, arguments);
                    };
                } catch (e) {
                }
            };
            try {
                wrap(history, 'pushState');
                wrap(history, 'replaceState');
            } catch (e) {
            }
            try {
                const assignOrig = location.assign.bind(location);
                location.assign = function (url) {
                    try {
                        window.__lastOpenedUrl = url;
                    } catch (e) {
                    }
                    ;
                    return assignOrig(url);
                };
            } catch (e) {
            }
            try {
                const replaceOrig = location.replace.bind(location);
                location.replace = function (url) {
                    try {
                        window.__lastOpenedUrl = url;
                    } catch (e) {
                    }
                    ;
                    return replaceOrig(url);
                };
            } catch (e) {
            }
            try {
                const loc = window.location;
                const proto = Object.getPrototypeOf(loc);
                const desc = Object.getOwnPropertyDescriptor(proto, 'href');
                if (desc && desc.set) {
                    const originalSetter = desc.set;
                    Object.defineProperty(loc, 'href', {
                        set: function (v) {
                            try {
                                window.__lastOpenedUrl = v;
                            } catch (e) {
                            }
                            ;
                            return originalSetter.call(this, v);
                        },
                        get: function () {
                            return desc.get.call(this);
                        },
                        configurable: true
                    });
                }
            } catch (e) {
            }
        })();
    });

    let lastMatchedUrl = null;
    const recentDetections = new Map();
    let consecutiveSkips = 0;
    let recoveryAttempts = 0; // count how many recovery reloads we already tried

    // Remove from the page any radar elements that correspond to URLs we already processed.
    // This prevents re-detection after reload and helps the loop to finish.
    // If aggressive=true, also remove by jogoId fragment (last path segment) and run broader matching.
    async function removeProcessedDomNodes(page, processedSet, aggressive = false) {
        try {
            const arr = Array.from(processedSet || []);
            if (!arr || arr.length === 0) return;
            // Limit to first 200 urls to avoid huge payload into page.evaluate
            const slice = arr.slice(0, 200);
            await page.evaluate((urls, aggressiveFlag) => {
                try {
                    const norm = (u) => {
                        try {
                            return u.replace(/[?#].*$/, '').replace(/\/$/, '');
                        } catch (e) {
                            return u;
                        }
                    };
                    const patterns = urls.map(u => norm(u));
                    // remove anchors and their containing rows that match processed urls
                    const anchors = Array.from(document.querySelectorAll('a'));
                    for (const a of anchors) {
                        try {
                            if (!a.href) continue;
                            const h = norm(a.href);
                            for (const p of patterns) {
                                if (!p) continue;
                                if (h.indexOf(p) !== -1 || p.indexOf(h) !== -1) {
                                    const tr = a.closest('tr');
                                    if (tr) tr.remove();
                                    if (a.parentElement) a.parentElement.removeChild(a);
                                    break;
                                }
                            }
                        } catch (e) {
                        }
                    }
                    // also remove any .radar elements whose inner anchor or data- attributes match
                    const radares = Array.from(document.querySelectorAll('.radar'));
                    for (const r of radares) {
                        try {
                            const a = r.querySelector('a');
                            const candidate = (a && a.href) ? norm(a.href) : (r.dataset && (r.dataset.href || r.dataset.url) ? norm(r.dataset.href || r.dataset.url) : null);
                            if (!candidate) continue;
                            for (const p of patterns) {
                                if (!p) continue;
                                if (candidate.indexOf(p) !== -1 || p.indexOf(candidate) !== -1) {
                                    const tr = r.closest('tr');
                                    if (tr) tr.remove();
                                    if (r.parentElement) r.parentElement.removeChild(r);
                                    break;
                                }
                            }
                            // aggressive: also match by last path segment (jogoId) or by substring
                            if (aggressiveFlag) {
                                try {
                                    const lastSeg = candidate.split('/').filter(Boolean).pop();
                                    for (const p of patterns) {
                                        if (!p) continue;
                                        const pLast = p.split('/').filter(Boolean).pop();
                                        if (!pLast) continue;
                                        if (candidate.includes(pLast) || lastSeg.includes(pLast) || p.includes(lastSeg)) {
                                            const tr2 = r.closest('tr');
                                            if (tr2) tr2.remove();
                                            if (r.parentElement) r.parentElement.removeChild(r);
                                            break;
                                        }
                                    }
                                } catch (e) {
                                }
                            }
                        } catch (e) {
                        }
                    }
                } catch (e) {
                }
            }, slice, aggressive).catch(() => {
            });
            await new Promise(r => setTimeout(r, 200));
        } catch (e) {
        }
    }

    // Aggressive removal by a single jogoId fragment. Used when reload keeps re-creating the same rows.
    async function forceRemoveById(page, jogoId) {
        try {
            await page.evaluate((id) => {
                try {
                    if (!id) return;
                    const anchors = Array.from(document.querySelectorAll('a'));
                    for (const a of anchors) {
                        try {
                            if (!a.href) continue;
                            if (a.href.indexOf(id) !== -1 || a.href.split('/').pop() === id) {
                                const tr = a.closest('tr');
                                if (tr) tr.remove();
                                if (a.parentElement) a.parentElement.removeChild(a);
                            }
                        } catch (e) {
                        }
                    }
                    const radares = Array.from(document.querySelectorAll('.radar'));
                    for (const r of radares) {
                        try {
                            const a = r.querySelector('a');
                            const cand = (a && a.href) ? a.href : (r.dataset && (r.dataset.href || r.dataset.url) ? (r.dataset.href || r.dataset.url) : '');
                            if (!cand) continue;
                            if (cand.indexOf(id) !== -1 || cand.split('/').pop() === id) {
                                const tr = r.closest('tr');
                                if (tr) tr.remove();
                                if (r.parentElement) r.parentElement.removeChild(r);
                            }
                        } catch (e) {
                        }
                    }
                } catch (e) {
                }
            }, String(jogoId)).catch(() => {
            });
            await new Promise(r => setTimeout(r, 150));
        } catch (e) {
        }
    }

    page.on('response', async (res) => {
        try {
            const url = res.url();
            if (!/radar|game|match|partida|jogo/i.test(url)) return;
            const ct = (res.headers() && res.headers()['content-type']) || '';
            if (!/json|text|html|application/i.test(ct) && !url.includes('/radar')) return;
            const text = await res.text().catch(() => null);
            if (!text) return;
            if (text.toLowerCase().includes('radar') || /\/radar\//i.test(text)) {
                const m = text.match(/https?:\/\/[^\"]*radar[^\"\s]*/i) || text.match(/\/radar\/[^\"'\s\}\]]+/i);
                if (m) {
                    lastMatchedUrl = m[0];
                    console.log('[Scout][NET] Captured radar URL from response:', lastMatchedUrl);
                }
            }
        } catch (e) {
        }
    });

    await page.goto('https://www.radarfutebol.com/', {waitUntil: 'networkidle2'});
    await closePrivacyModal(page).catch(() => {
    });

    await page.evaluate(() => {
        const btn = document.querySelector('button[data-role="all"]');
        if (btn) btn.click();
        const liveBtn = Array.from(document.querySelectorAll('button')).find(b => b.innerText?.toUpperCase().includes('AO VIVO'));
        if (liveBtn) liveBtn.click();
    });

    await new Promise(r => setTimeout(r, 5000));
    // Clean up any already-processed nodes right after initial load so the loop won't re-visit them
    try {
        await removeProcessedDomNodes(page, processados);
    } catch (e) {
    }

    async function extractUrlFromElement(elHandle) {
        return await elHandle.evaluate(el => {
            try {
                if (el.dataset) {
                    const keys = ['href', 'url', 'link'];
                    for (const k of keys) if (el.dataset[k]) return el.dataset[k];
                }
                const a = el.querySelector && el.querySelector('a');
                if (a && a.href) return a.href;
                if (el.__vueParentComponent && el.__vueParentComponent.vnode && el.__vueParentComponent.vnode.props) {
                    const p = el.__vueParentComponent.vnode.props;
                    if (p.url) return p.url;
                    if (p.href) return p.href;
                }
                if (el.__vue__) {
                    const p = el.__vue__.$props || el.__vue__.$options;
                    if (p && (p.url || p.href)) return p.url || p.href;
                }
                let pnode = el;
                for (let depth = 0; depth < 6 && pnode; depth++) {
                    const v = pnode.__vueParentComponent || pnode.__vue__;
                    if (v && v.props) {
                        if (v.props.url) return v.props.url;
                        if (v.props.href) return v.props.href;
                    }
                    pnode = pnode.parentElement;
                }
            } catch (e) {
            }
            return null;
        });
    }

    try {
        console.log(`[${new Date().toLocaleTimeString()}] Monitorando grade existente...`);
        try {
            await page.evaluate(() => {
                const btn = document.querySelector('button[data-role="all"]');
                if (btn) btn.click();
                const liveBtn = Array.from(document.querySelectorAll('button')).find(b => b.innerText?.toUpperCase().includes('AO VIVO'));
                if (liveBtn) liveBtn.click();
            });
            await new Promise(r => setTimeout(r, 1000));
        } catch (e) {
        }

        const radarElements = await page.$$('tbody tr .radar');
        const totalRadares = radarElements.length;
        console.log(`[Scout] Radares ativos na grade: ${totalRadares}`);

        let processedThisCycle = 0;
        let i = 0;
        // If the page temporarily runs out of visible games, try scrolling to load more
        let emptyVisibleCount = 0;
        // Count consecutive iterations where there are no unprocessed items (end of page)
        let noUnprocessedLoops = 0;
        // If we make no progress for several iterations, force a scroll to trigger lazy-loading
        let loopsSinceProgress = 0;
        let lastProgressCount = 0;
        const MAX_EMPTY_SCROLL_ATTEMPTS = 5;
        while (true) {
            try {
                // Check for unprocessed radar elements (not marked data-processed and not data-processing)
                const unprocessedCount = await page.evaluate(() => {
                    try {
                        return document.querySelectorAll('tbody tr .radar:not([data-processed]):not([data-processing])').length || 0;
                    } catch (e) {
                        return 0;
                    }
                });

                if (!unprocessedCount || unprocessedCount === 0) {
                    // no unprocessed items visible: attempt scrolls to load more
                    noUnprocessedLoops++;
                    emptyVisibleCount++;
                    if (emptyVisibleCount > MAX_EMPTY_SCROLL_ATTEMPTS || noUnprocessedLoops > 6) {
                        // consider end of page reached
                        console.log('[Scout] Fim aparente da página detectado (sem itens não processados) — saindo.');
                        break;
                    }
                    try {
                        await page.evaluate(() => {
                            try {
                                window.scrollBy({ top: window.innerHeight * 0.9, behavior: 'smooth' });
                            } catch (e) {}
                        });
                    } catch (e) {}
                    // small wait for DOM to update after scroll
                    await new Promise(r => setTimeout(r, 700));
                    continue;
                }
                // reset counters when we have unprocessed elements
                emptyVisibleCount = 0;
                noUnprocessedLoops = 0;

                // detect lack of progress: if processedThisCycle hasn't increased, increment loopsSinceProgress
                if (processedThisCycle === lastProgressCount) {
                    loopsSinceProgress++;
                } else {
                    loopsSinceProgress = 0;
                    lastProgressCount = processedThisCycle;
                }
                // after 3 iterations with no progress, attempt a scroll to load more items
                if (loopsSinceProgress >= 3) {
                    // Try a sequence of stronger scroll attempts (multiple small steps)
                    try {
                        const prevCount = (await page.$$('tbody tr .radar')).length;
                        for (let s = 0; s < 4; s++) {
                            try {
                                await page.evaluate((step) => { window.scrollBy({ top: window.innerHeight * step, behavior: 'smooth' }); }, 0.4 + s * 0.2);
                            } catch (e) {}
                            await new Promise(r => setTimeout(r, 600));
                            const nowCount = (await page.$$('tbody tr .radar')).length;
                            if (nowCount > prevCount) break; // new items loaded
                        }
                    } catch (e) {}
                    // small pause to allow any lazy loads to finish
                    await new Promise(r => setTimeout(r, 900));
                    loopsSinceProgress = 0;
                    // re-evaluate elements after aggressive scrolls
                    continue;
                }

                // fetch the list of unprocessed element handles and pick the first
                const elementsNow = await page.$$('tbody tr .radar:not([data-processed]):not([data-processing])');
                const el = elementsNow && elementsNow.length ? elementsNow[0] : null;
                if (!el) {
                    // nothing to process in this iteration; continue loop to allow scroll/retry logic
                    continue;
                }

                let urlFinal = await extractUrlFromElement(el);

                try {
                    if (urlFinal) {
                        if (processados.has(urlFinal)) {
                            await el.evaluate(node => node.setAttribute('data-processed', '1'));
                            await el.evaluate(node => {
                                const tr = node.closest('tr');
                                if (tr) tr.remove();
                            });
                            await new Promise(r => setTimeout(r, 300));
                            continue;
                        }
                    } else {
                        const inferred = await el.evaluate(node => {
                            try {
                                const a = node.closest('tr') && node.closest('tr').querySelector('a');
                                if (a && a.href) return a.href.split('/').pop();
                                if (node.dataset) {
                                    if (node.dataset.id) return node.dataset.id;
                                    if (node.dataset.href) return node.dataset.href.split('/').pop();
                                }
                            } catch (e) {
                            }
                            return null;
                        }).catch(() => null);
                        if (inferred && processados.has(inferred)) {
                            await el.evaluate(node => node.setAttribute('data-processed', '1'));
                            await el.evaluate(node => {
                                const tr = node.closest('tr');
                                if (tr) {
                                    tr.remove();
                                    return;
                                }
                                const container = node.closest('div.shadow.overflow-hidden');
                                if (container) container.remove();
                            });
                            await new Promise(r => setTimeout(r, 300));
                            continue;
                        }
                    }
                } catch (e) {
                }
                if (!urlFinal) {
                    lastMatchedUrl = null;

                    const inferredBefore = await el.evaluate(node => {
                        try {
                            const a = node.closest('tr') && node.closest('tr').querySelector('a');
                            if (a && a.href) return a.href.split('/').pop();
                            if (node.dataset) {
                                if (node.dataset.id) return node.dataset.id;
                                if (node.dataset.href) return node.dataset.href.split('/').pop();
                            }
                        } catch (e) {
                        }
                        return null;
                    }).catch(() => null);
                    if (inferredBefore && inProgress.has(inferredBefore)) {
                        await el.evaluate(node => node.setAttribute('data-processed', '1')).catch(() => {
                        });
                        await el.evaluate(node => {
                            const tr = node.closest('tr');
                            if (tr) tr.remove();
                        }).catch(() => {
                        });
                        await new Promise(r => setTimeout(r, 300));
                        continue;
                    }

                    await el.evaluate(node => node.setAttribute('data-processing', '1')).catch(() => {
                    });
                    let capturedFromNewPage = null;
                    const targetListener = async (target) => {
                        try {
                            const p = await target.page();
                            if (!p) return;
                            // Enable request interception for this transient page but guard against
                            // double-resolution races. We must abort requests here (to avoid 403s)
                            // so the opened page doesn't perform restricted network calls.
                            try {
                                await p.setRequestInterception(true);
                            } catch (e) {
                                // ignore: some targets may not allow interception
                            }
                            const _handledRequests = new WeakSet();
                            p.on('request', req => {
                                try {
                                    // If Puppeteer exposes isInterceptResolutionHandled(), use it.
                                    if (typeof req.isInterceptResolutionHandled === 'function') {
                                        try {
                                            if (req.isInterceptResolutionHandled()) return;
                                        } catch (e) {
                                            // fallthrough
                                        }
                                    }
                                    if (_handledRequests.has(req)) return;
                                    _handledRequests.add(req);
                                    try {
                                        req.abort();
                                    } catch (err) {
                                        // abort can throw if already handled; ignore to avoid crash
                                    }
                                } catch (e) {
                                    // swallow unexpected errors
                                }
                            });

                            try {
                                await Promise.race([
                                    p.waitForNavigation({waitUntil: 'domcontentloaded', timeout: 3000}).catch(() => {
                                    }),
                                    new Promise(r => setTimeout(r, 1500))
                                ]);
                            } catch (e) {
                            }
                            try {
                                const u = p.url();
                                if (u) capturedFromNewPage = u;
                            } catch (e) {
                            }
                            try {
                                await p.close();
                            } catch (e) {
                            }
                        } catch (e) {
                        }
                    };
                    browser.once('targetcreated', targetListener);
                    const box = await el.boundingBox();
                    if (box) {
                        await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
                    } else {
                        await el.evaluate(node => {
                            try {
                                node.dispatchEvent(new MouseEvent('click', {
                                    bubbles: true,
                                    cancelable: true,
                                    view: window
                                }));
                            } catch (e) {
                            }
                        });
                    }

                    await new Promise(r => setTimeout(r, CLICK_DELAY));
                    try {
                        browser.removeListener('targetcreated', targetListener);
                    } catch (e) {
                    }
                    if (capturedFromNewPage) lastMatchedUrl = lastMatchedUrl || capturedFromNewPage;

                    try {
                        const winLast = await page.evaluate(() => {
                            try {
                                return window.__lastOpenedUrl || null;
                            } catch (e) {
                                return null;
                            }
                        });
                        if (winLast) lastMatchedUrl = lastMatchedUrl || winLast;
                    } catch (e) {
                    }

                    if (lastMatchedUrl) {
                        urlFinal = lastMatchedUrl;
                    }
                }

                if (!urlFinal) {
                    try {
                        const diag = {outer: null, rowHtml: null, bbox: null, lastMatchedUrl: lastMatchedUrl};
                        try {
                            diag.outer = await el.evaluate(node => node.outerHTML).catch(() => null);
                            diag.rowHtml = await el.evaluate(node => {
                                const tr = node.closest('tr');
                                return tr ? tr.innerHTML : null;
                            }).catch(() => null);
                            const b = await el.boundingBox();
                            if (b) diag.bbox = {x: b.x, y: b.y, width: b.width, height: b.height};
                        } catch (e) {
                        }
                        try {
                            const lastOpen = await page.evaluate(() => {
                                try {
                                    return window.__lastOpenedUrl || null;
                                } catch (e) {
                                    return null;
                                }
                            });
                            if (lastOpen) diag.windowLastOpened = lastOpen;
                        } catch (e) {
                        }

                        const ts = Date.now();
                        console.warn(`[Scout] Não foi possível obter URL do radar para o jogo na posição ${i}. Diagnostic:`, diag);
                        try {
                            const screenshotsDir = path.join(__dirname, 'log', 'telemetria');
                            if (!fs.existsSync(screenshotsDir)) fs.mkdirSync(screenshotsDir, {recursive: true});
                            const file = path.join(screenshotsDir, `inspect_radar_pos_${i}_${ts}.png`);
                            try {
                                await closePrivacyModal(page);
                            } catch (_) {
                            }
                            if (diag.bbox) {
                                await page.screenshot({
                                    path: file,
                                    clip: {
                                        x: Math.max(0, diag.bbox.x),
                                        y: Math.max(0, diag.bbox.y),
                                        width: Math.min(diag.bbox.width, 2000),
                                        height: Math.min(diag.bbox.height, 2000)
                                    }
                                }).catch(() => {
                                });
                            } else {
                                await page.screenshot({path: file, fullPage: false}).catch(() => {
                                });
                            }
                            console.log('[Scout] Screenshot salva em', file);
                        } catch (e) {
                            console.warn('[Scout] Falha ao salvar screenshot de diagnóstico:', e && e.message ? e.message : e);
                        }
                    } catch (e) {
                        console.warn('[Scout] Erro ao coletar diagnósticos:', e && e.message ? e.message : e);
                    }
                    continue;
                }

                try {
                    if (/^\//.test(urlFinal)) {
                        urlFinal = new URL(urlFinal, 'https://www.radarfutebol.com').toString();
                    }
                    urlFinal = urlFinal.replace(/^"|"$/g, '').trim();
                    urlFinal = urlFinal.replace(/[?#].*$/, '').replace(/\/$/, '');
                } catch (e) {
                    console.warn('[Scout] Erro ao normalizar URL:', urlFinal, e.message || e);
                }

                const now = Date.now();
                const normUrlKey = urlFinal;
                const lastTs = recentDetections.get(normUrlKey) || 0;
                const DEBOUNCE_WINDOW = 30_000;
                if (now - lastTs < DEBOUNCE_WINDOW) {
                    recentDetections.set(normUrlKey, now);
                    continue;
                }
                recentDetections.set(normUrlKey, now);
                if (recentDetections.size > 2000) {
                    const cutoff = now - (5 * 60_000);
                    for (const [k, v] of recentDetections.entries()) if (v < cutoff) recentDetections.delete(k);
                }

                console.log('[Scout] URL final detectada:', urlFinal);

                const jogoId = urlFinal.split('/').pop();
                        if (processados.has(jogoId) || processados.has(urlFinal) || inProgress.has(jogoId) || inProgress.has(urlFinal)) {
                    try {
                        await el.evaluate(node => node.setAttribute('data-processed', '1'));
                        await el.evaluate(node => {
                            const tr = node.closest('tr');
                            if (tr) {
                                tr.remove();
                                return;
                            }
                            const container = node.closest('div.shadow.overflow-hidden');
                            if (container) container.remove();
                        }).catch(() => {
                        });
                        try {
                            processados.add(urlFinal);
                            if (jogoId) processados.add(jogoId);
                        } catch (_) {
                        }
                        try {
                            saveProcessedSet(processados);
                        } catch (_) {
                        }
                        try {
                            inProgress.delete(jogoId);
                        } catch (_) {
                        }
                        try {
                            inProgress.delete(urlFinal);
                        } catch (_) {
                        }
                    } catch (e) {
                    }
                    try {
                        console.log('[Scout] Skipping jogoId=', jogoId, ' processedHasId=', processados.has(jogoId), ' processedHasUrl=', processados.has(urlFinal), ' inProgress size=', inProgress.size);
                    } catch (_) {
                        console.log('[Scout] Skipping jogoId=', jogoId);
                    }
                    await new Promise(r => setTimeout(r, 300));
                    continue;
                } else if (!processados.has(jogoId)) {
                        try {
                        // basic URL validation: prefer /radar/ links or a trailing numeric id
                        const isRadarLike = /\/radar\//i.test(urlFinal) || /\/(\d+)$/.test(urlFinal);
                        if (!isRadarLike) {
                            console.log('[Scout] URL não parece ser radar/jogo, pulando envio mas marcando como processado:', urlFinal);
                            // mark both forms to avoid re-detection
                            try { processados.add(urlFinal); if (jogoId) processados.add(jogoId); saveProcessedSet(processados); } catch (_) {}
                            try { await el.evaluate(node => node.setAttribute('data-processed', '1')); } catch (_) {}
                            try { await el.evaluate(node => { const tr = node.closest('tr'); if (tr) tr.remove(); }); } catch(_) {}
                            continue;
                        }

                        inProgress.add(jogoId);
                        inProgress.add(urlFinal);
                        const sendResult = await sendToServer(urlFinal);
                        if (sendResult && sendResult.ok) {
                            console.log(`✅ [SUCESSO] Jogo ${jogoId} enviado.`);
                            consecutiveSkips = 0;
                                try {
                                    processados.add(urlFinal);
                                    if (jogoId) processados.add(jogoId);
                                } catch (_) {
                                }
                                try {
                                    processados.add(urlFinal);
                                    if (jogoId) processados.add(jogoId);
                                } catch (_) {
                                }
                            try {
                                saveProcessedSet(processados);
                            } catch (e) {
                                console.warn('Erro salvando processados:', e.message || e);
                            }
                            await el.evaluate(node => node.setAttribute('data-processed', '1'));
                            await el.evaluate(node => {
                                const tr = node.closest('tr');
                                if (tr) {
                                    tr.remove();
                                    return;
                                }
                                const container = node.closest('div.shadow.overflow-hidden');
                                if (container) container.remove();
                            }).catch(() => {
                            });
                            try {
                                await page.evaluate((id) => {
                                    try {
                                        const anchors = Array.from(document.querySelectorAll('a')).filter(a => a.href && a.href.includes(id));
                                        for (const a of anchors) {
                                            const tr = a.closest('tr');
                                            if (tr) tr.remove();
                                        }
                                        const radares = Array.from(document.querySelectorAll('.radar[data-processing]'));
                                        for (const r of radares) {
                                            const tr = r.closest('tr');
                                            if (tr) tr.remove();
                                        }
                                    } catch (e) {
                                    }
                                }, jogoId);
                            } catch (e) {
                            }
                            try {
                                inProgress.delete(urlFinal);
                            } catch (_) {
                            }
                            try {
                                inProgress.delete(jogoId);
                            } catch (_) {
                            }
                        } else {
                            let handled = false;
                            try {
                                if (sendResult && sendResult.status) {
                                    const st = sendResult.status;
                                    const body = sendResult.body;
                                    if (st === 409 && typeof body === 'string') {
                                        const js = JSON.parse(body);
                                        if (js && js.erro && /Jogo já iniciado/i.test(js.erro)) {
                                            console.log(`[Scout] Servidor diz que o jogo já iniciou para ${jogoId}, marcando como processado.`);
                                            try {
                                                processados.add(urlFinal);
                                                if (jogoId) processados.add(jogoId);
                                            } catch (_) {
                                            }
                                            try {
                                                saveProcessedSet(processados);
                                            } catch (e) {
                                            }
                                            await el.evaluate(node => node.setAttribute('data-processed', '1'));
                                            await el.evaluate(node => {
                                                const tr = node.closest('tr');
                                                if (tr) {
                                                    tr.remove();
                                                    return;
                                                }
                                                const container = node.closest('div.shadow.overflow-hidden');
                                                if (container) container.remove();
                                            });
                                            handled = true;
                                        }
                                    }
                                }
                            } catch (e) {
                            }
                            if (!handled) console.warn('[Scout] Falha ao enviar para o servidor', sendResult);
                        }
                    } catch (e) {
                        console.warn('[Scout] Erro ao enviar jogo:', e.message || e);
                        try {
                            inProgress.delete(jogoId);
                        } catch (_) {
                        }
                        try {
                            inProgress.delete(urlFinal);
                        } catch (_) {
                        }
                    }
                }

                await new Promise(r => setTimeout(r, CLICK_DELAY));
                processedThisCycle++;
                i++;
            } catch (e) {
                console.error('Erro interno no loop de radares:', e.message || e);
                break;
            }
        }

        try {
            saveProcessedSet(processados);
        } catch (e) {
            console.warn('[Scout] Erro salvando processados antes de sair:', e && e.message ? e.message : e);
        }
        try {
            console.log('Finalizando Robo.');
            await browser.close();
        } catch (e) {
        }
        globalBrowser = null;
        return;
    } catch (e) {
        console.error('Erro crítico:', e.message || e);
        try {
            await page.reload();
        } catch (e) {
        }
    }
}

async function _gracefulShutdown(signal) {
    try {
        saveProcessedSet(processadosGlobal);
    } catch (e) {
    }
    if (globalBrowser) {
        try {
            console.log(`[Scout] ${signal} received, closing browser...`);
            await globalBrowser.close();
        } catch (e) {
            console.warn('[Scout] Erro fechando browser na finalização:', e && e.message ? e.message : e);
        }
        globalBrowser = null;
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

let processadosGlobal = null;

(async () => {
    processadosGlobal = loadProcessed();
    await rodarMinerador();
})();

async function sendToServer(urlToSend) {
    const maxAttempts = 6;
    const baseDelay = 1500;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
            const data = JSON.stringify({url: urlToSend});
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
                timeout: 30000
            };
            const result = await new Promise((resolve) => {
                const req = http.request(options, (res) => {
                    let body = '';
                    res.on('data', (chunk) => body += chunk);
                    res.on('end', () => {
                        resolve({ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode, body});
                    });
                });
                req.on('error', (err) => resolve({ok: false, error: err.message}));
                req.on('timeout', () => {
                    req.destroy();
                    resolve({ok: false, error: 'timeout'});
                });
                req.write(data);
                req.end();
            });

            // If we timed out but the server might have processed the request, do one
            // extra confirmation attempt with a longer timeout before giving up.
            if (result && result.ok === false && result.error === 'timeout') {
                try {
                    console.log('[Scout] Timeout no envio — efetuando tentativa de confirmação extra...');
                    const confirmOptions = Object.assign({}, options, {timeout: 30000});
                    const confirm = await new Promise((resolve) => {
                        const creq = http.request(confirmOptions, (res) => {
                            let body = '';
                            res.on('data', c => body += c);
                            res.on('end', () => resolve({ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode, body}));
                        });
                        creq.on('error', (err) => resolve({ok: false, error: err.message}));
                        creq.on('timeout', () => { creq.destroy(); resolve({ok: false, error: 'timeout'}); });
                        try { creq.write(data); creq.end(); } catch (e) { resolve({ok: false, error: String(e)}); }
                    });
                    if (confirm && confirm.ok) return confirm;
                } catch (e) {
                    // swallow and fallthrough to return original timeout
                }
            }

                if (result && result.status === 503 && typeof result.body === 'string' && result.body.includes('Engine ainda não pronta')) {
                if (attempt < maxAttempts) {
                    const wait = baseDelay * attempt;
                    console.log(`[Scout] Servidor ainda inicializando (attempt ${attempt}/${maxAttempts}), aguardando ${wait}ms antes de tentar novamente`);
                    await new Promise(r => setTimeout(r, wait));
                    continue;
                }
            }
            // successful or final result (even errors) return to caller for handling
            return result;
        } catch (e) {
            if (attempt < maxAttempts) {
                const wait = baseDelay * attempt;
                console.log(`[Scout] Erro ao conectar ao servidor (attempt ${attempt}/${maxAttempts}): ${e.message || e} — aguardando ${wait}ms`);
                await new Promise(r => setTimeout(r, wait));
                continue;
            }
            return {ok: false, error: e.message || String(e)};
        }
    }
    return {ok: false, error: 'max_attempts_exceeded'};
}
