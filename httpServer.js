const fs = require('fs');
const path = require('path');
const http = require('http');
// Load .env into process.env for local development
try { require('dotenv').config(); } catch(e) { /* optional */ }

module.exports = (props) => {
    const {clientesSSE, getDadosUltimosJogos, _callbackAdicionarJogo, _screenshotsMomentum} = props;
    // getDadosUltimosJogos is a function provided by logger.js that returns the up-to-date array

    let clientFront = clientesSSE;

    const server = http.createServer((req, res) => {
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
        if (req.method === 'OPTIONS') { res.writeHead(200); res.end(); return; }

        if (req.url === '/' && req.method === 'GET') {
            // 1. Aponta para o arquivo que você quer carregar (ex: index.html)
            const filePath = path.join(__dirname, 'index.html');

            // 2. Lê o arquivo de forma assíncrona para não travar o servidor
            fs.readFile(filePath, (err, data) => {
                if (err) {
                    // Se der erro ao ler o arquivo (ex: arquivo não existe)
                    res.writeHead(500, { 'Content-Type': 'text/plain' });
                    return res.end('Erro interno no servidor.');
                }

                // 3. Define o mimeType e envia os dados corrigidos
                const mimeType = 'text/html';
                res.writeHead(200, { 'Content-Type': mimeType });
                res.end(data);
            });
            return; // return immediately after scheduling fs.readFile to avoid fall-through
        }
        if (req.url === '/events' && req.method === 'GET') {
            res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' });
            clientFront.push(res);
            // send current snapshot using the getter so new clients see the latest state
            const initialSnapshot = (typeof getDadosUltimosJogos === 'function' ? getDadosUltimosJogos() : []);
            try {
                res.write(`data: ${JSON.stringify(initialSnapshot)}\n\n`);
            } catch (e) {
                // If writing the initial snapshot fails, remove the client and don't send an empty payload
                try { const idx = clientFront.indexOf(res); if (idx !== -1) clientFront.splice(idx, 1); } catch(e) {}
            }
            // remove closed clients by mutating the original array (keeps the same reference passed from logger.js)
            req.on('close', () => {
                try {
                    const idx = clientFront.indexOf(res);
                    if (idx !== -1) clientFront.splice(idx, 1);
                } catch (e) {}
            });
            return; // keep request open for SSE, do not continue to other handlers

        }

        if (req.url.startsWith('/screenshot/') && req.method === 'GET') {
            // Serve a imagem do gráfico momentum como JPEG binário
            const jogoId = req.url.split('/screenshot/')[1]?.split('?')[0];
            const imgBase64 = jogoId ? _screenshotsMomentum.get(jogoId) : null;
            if (imgBase64) {
                const buffer = Buffer.from(imgBase64.replace('data:image/jpeg;base64,', ''), 'base64');
                res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Cache-Control': 'no-store' });
                res.end(buffer);
                return;
            } else {
                res.writeHead(204); res.end(); // No Content — ainda sem screenshot
                return;
            }

        }

        // DASHBOARD: serve página e API para historico_gatilhos.csv
        if (req.url === '/dashboard' && req.method === 'GET') {
            const filePath = path.join(__dirname, 'dashboard.html');
            fs.readFile(filePath, (err, data) => {
                if (err) { res.writeHead(500, { 'Content-Type': 'text/plain' }); return res.end('Erro interno'); }
                res.writeHead(200, { 'Content-Type': 'text/html' }); res.end(data);
            });
            return;
        }

        // New explicit API endpoints to serve compact/full telemetry JSON regardless of static handlers
        if ((req.url === '/api/reports/telemetry_report_compact.json' || req.url === '/api/reports/telemetry_report.json') && req.method === 'GET') {
            try {
                const rel = req.url.split('/api/reports/').pop();
                const filePath = path.join(__dirname, 'reports', rel);
                if (!fs.existsSync(filePath)) { res.writeHead(404, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ ok:false, erro: 'not found' })); }
                const data = fs.readFileSync(filePath, 'utf8');
                res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache' });
                return res.end(data);
            } catch (e) {
                res.writeHead(500, { 'Content-Type': 'application/json' });
                return res.end(JSON.stringify({ ok:false, erro: String(e && e.message ? e.message : e) }));
            }
        }

        if (req.url === '/api/historico' && req.method === 'GET') {
            // Read and parse CSV into JSON. Merge any pending confirmations so totals reflect user edits
            const csvPath = path.join(__dirname, 'historico_gatilhos.csv');
            const cnfPath = path.join(__dirname, 'historico_confirmacoes.json');
            fs.readFile(csvPath, 'utf8', (err, data) => {
                if (err) { res.writeHead(500, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ ok:false, erro: err.message })); }
                let confirmacoes = {};
                try { if (fs.existsSync(cnfPath)) confirmacoes = JSON.parse(fs.readFileSync(cnfPath, 'utf8') || '{}'); } catch(e) { confirmacoes = {}; }

                const lines = data.split(/\r?\n/);
                const rows = [];
                const totals = {};
                lines.forEach((ln, idx) => {
                    if (!ln || ln.trim() === '') return; // keep index consistent with file (skip empty lines)
                    const cols = ln.split(';').map(c=>c.trim());
                    // normalize: last non-empty token from CSV is original result if exists
                    let resultado = '';
                    for (let i = cols.length-1; i >= 0; i--) { if (cols[i]) { resultado = cols[i]; break; } }
                    // If the last token is an internal signal id (ex: sig_12345...), hide it from the "resultado"
                    // and present a human-friendly status instead (Portuguese: 'PENDENTE').
                    if (typeof resultado === 'string' && resultado.startsWith('sig_')) {
                        resultado = 'PENDENTE';
                    }

                    // if there is a pending confirmation for this row id, override the resultado for display/totals
                    const id = idx + 1;
                    if (confirmacoes && confirmacoes[String(id)] && confirmacoes[String(id)].resultado) {
                        resultado = String(confirmacoes[String(id)].resultado || '').trim();
                    }

                    const row = {
                        id: id,
                        raw: ln,
                        dateTime: cols[0]||'',
                        partida: cols[1]||'',
                        tipo: cols[2]||'',
                        tempo: cols[3]||'',
                        placar: cols[4]||'',
                        odd: cols[5]||'',
                        pressao: cols[6]||'',
                        qualidade: cols[7]||'',
                        resultado: resultado || ''
                    };
                    rows.push(row);
                    if (!totals[row.tipo]) totals[row.tipo] = { total:0, GREEN:0, RED:0, UNKNOWN:0 };
                    totals[row.tipo].total++;
                    if (row.resultado && row.resultado.toUpperCase().includes('GREEN')) totals[row.tipo].GREEN++;
                    else if (row.resultado && row.resultado.toUpperCase().includes('RED')) totals[row.tipo].RED++;
                    else totals[row.tipo].UNKNOWN++;
                });
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ ok:true, rows, totals }));
            });
            return;
        }

        if (req.url.match(/^\/api\/historico\/\d+$/) && req.method === 'POST') {
            // Update a line's resultado (GREEN/RED)
            const id = parseInt(req.url.split('/').pop(), 10);
            let bodyData = '';
            req.on('data', c => bodyData += c);
            req.on('end', () => {
                try {
                    const payload = JSON.parse(bodyData || '{}');
                    const novo = String((payload.resultado || '').toUpperCase()).trim();
                    if (!novo || (novo !== 'GREEN' && novo !== 'RED')) {
                        res.writeHead(400, { 'Content-Type': 'application/json' });
                        return res.end(JSON.stringify({ ok:false, erro:'resultado inválido (use GREEN or RED)' }));
                    }
                    // Save confirmation to a separate JSON file to avoid touching the original CSV
                    const cnfPath = path.join(__dirname, 'historico_confirmacoes.json');
                    let cnf = {};
                    try { if (fs.existsSync(cnfPath)) cnf = JSON.parse(fs.readFileSync(cnfPath, 'utf8') || '{}'); } catch(e) { cnf = {}; }
                    cnf[String(id)] = { resultado: novo, ts: Date.now() };
                    fs.writeFileSync(cnfPath, JSON.stringify(cnf, null, 2), 'utf8');
                    // Also apply immediately to CSV so dashboard reflects the change without needing /apply
                    try {
                        const csvPath = path.join(__dirname, 'historico_gatilhos.csv');
                        if (fs.existsSync(csvPath)) {
                            const txt = fs.readFileSync(csvPath, 'utf8');
                            const lines = txt.split(/\r?\n/);
                            if (id >=1 && id <= lines.length && lines[id-1].trim() !== '') {
                                const cols = lines[id-1].split(';').map(c=>c);
                                // robustly remove any existing sig_ token and trailing notes, then write STATUS
                                let idCol = cols.findIndex(c => typeof c === 'string' && c.trim().startsWith('sig_'));
                                if (idCol !== -1) {
                                    const statusCol = Math.max(0, idCol - 1);
                                    cols[statusCol] = novo;
                                    // Remove the signal id and any trailing tokens so CSV has no sig_/notes after apply
                                    cols.splice(statusCol + 1);
                                } else {
                                    // No sig_ found: replace the last non-empty token (legacy format)
                                    for (let i = cols.length-1;i>=0;i--) {
                                        if (cols[i] && cols[i].trim() !== '') { cols[i] = novo; break; }
                                    }
                                }
                                // ensure line ends with an empty token after STATUS for consistent CSV layout
                                if (cols[cols.length-1] !== '') cols.push('');
                                lines[id-1] = cols.join(';');
                                fs.writeFileSync(csvPath, lines.join('\n'), 'utf8');
                                // remove confirmation since applied
                                delete cnf[String(id)];
                                fs.writeFileSync(cnfPath, JSON.stringify(cnf, null, 2), 'utf8');
                            }
                        }
                    } catch(e) { /* non-fatal */ }

                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    return res.end(JSON.stringify({ ok:true, id, resultado: novo }));
                } catch (e) {
                    res.writeHead(500, { 'Content-Type': 'application/json' });
                    return res.end(JSON.stringify({ ok:false, erro: e.message }));
                }
            });
            return;
        }

        if (req.url === '/api/confirmacoes' && req.method === 'GET') {
            const cnfPath = path.join(__dirname, 'historico_confirmacoes.json');
            let cnf = {};
            try { if (fs.existsSync(cnfPath)) cnf = JSON.parse(fs.readFileSync(cnfPath, 'utf8') || '{}'); } catch(e) { cnf = {}; }
            res.writeHead(200, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ ok:true, confirmacoes: cnf }));
        }

        // Apply confirmations to CSV (backup original first)
        if (req.url.startsWith('/api/historico/apply') && req.method === 'POST') {
            // Support optional body { ids: [1,2,3] } or query ?id=123 to apply only specific confirmations.
            let body = '';
            req.on('data', c => body += c);
            req.on('end', () => {
                try {
                    const csvPath = path.join(__dirname, 'historico_gatilhos.csv');
                    const cnfPath = path.join(__dirname, 'historico_confirmacoes.json');
                    if (!fs.existsSync(csvPath)) { res.writeHead(404, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ ok:false, erro:'CSV não encontrado' })); }
                    const cnf = (fs.existsSync(cnfPath) ? JSON.parse(fs.readFileSync(cnfPath, 'utf8')||'{}') : {});

                    // parse body to extract ids
                    let idsToApply = null;
                    try {
                        const payload = body ? JSON.parse(body) : {};
                        if (Array.isArray(payload.ids)) idsToApply = payload.ids.map(x => parseInt(x,10)).filter(n => isFinite(n));
                    } catch(e) { idsToApply = null; }
                    // also allow query ?id=123
                    try {
                        const qp = req.url.split('?')[1] || '';
                        const parts = qp.split('&').map(p => p.split('='));
                        for (const p of parts) if (p[0]==='id' && p[1]) { const n = parseInt(p[1],10); if (isFinite(n)) { idsToApply = idsToApply || []; idsToApply.push(n); } }
                    } catch(e) {}

                    if (!cnf || Object.keys(cnf).length===0) { res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ ok:true, applied:0 })); }

                    // if idsToApply is null -> apply all
                    const applyAll = !Array.isArray(idsToApply) || idsToApply.length===0;

                    // backup
                    const bk = csvPath + '.bak.' + Date.now();
                    fs.copyFileSync(csvPath, bk);
                    const txt = fs.readFileSync(csvPath, 'utf8');
                    const lines = txt.split(/\r?\n/);
                    let applied = 0;

                    for (const k of Object.keys(cnf)) {
                        const id = parseInt(k,10);
                        if (!isFinite(id) || id < 1 || id > lines.length) continue;
                        if (!applyAll && !idsToApply.includes(id)) continue;
                        if (!lines[id-1] || lines[id-1].trim()==='') continue;
                        const cols = lines[id-1].split(';').map(c=>c);
                        let replaced = false;
                        // Prefer to overwrite the STATUS column which should be immediately before the signal ID
                        const idCol = cols.findIndex(c => typeof c === 'string' && c.startsWith('sig_'));
                        if (idCol !== -1) {
                            const statusCol = Math.max(0, idCol - 1);
                            // Overwrite STATUS column
                            cols[statusCol] = String(cnf[k].resultado || '');
                            // Remove any stray tokens after the ID (e.g. notes like 'intervalo')
                            // Keep only up to idCol (inclusive)
                            cols.splice(idCol + 1);
                            replaced = true;
                        } else {
                            // fallback: replace last non-empty token (legacy behaviour)
                            for (let i = cols.length-1; i>=0; i--) {
                                if (cols[i] && cols[i].trim() !== '') { cols[i] = String(cnf[k].resultado || ''); replaced = true; break; }
                            }
                            if (!replaced) cols.push(String(cnf[k].resultado || ''));
                        }
                        lines[id-1] = cols.join(';');
                        applied++;
                        // remove applied confirmation from cnf
                        delete cnf[String(id)];
                    }

                    fs.writeFileSync(csvPath, lines.join('\n'), 'utf8');
                    // save remaining confirmations (or remove file if empty)
                    if (Object.keys(cnf).length === 0) {
                        try { fs.unlinkSync(cnfPath); } catch(e) {}
                    } else {
                        fs.writeFileSync(cnfPath, JSON.stringify(cnf, null, 2), 'utf8');
                    }
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    return res.end(JSON.stringify({ ok:true, applied }));
                } catch (e) {
                    res.writeHead(500, { 'Content-Type': 'application/json' });
                    return res.end(JSON.stringify({ ok:false, erro: e.message }));
                }
            });
            return;
        }

        if (req.url === '/add-game' && req.method === 'POST') {
            let body = '';
            req.on('data', chunk => { body += chunk; });
            req.on('end', async () => {
                try {
                    const { url } = JSON.parse(body);
                    if (!url || !url.startsWith('http')) {
                        res.writeHead(400, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({ ok: false, erro: 'URL inválida' }));
                        return;
                    }
                    // Verificação rápida local: evita chamar a engine se já existe um jogo com mesmo ID
                    const idJogoUnico = String(url.split('/').pop() || '');
                    const snapshot = (typeof getDadosUltimosJogos === 'function' ? getDadosUltimosJogos() : []);
                    if (idJogoUnico && Array.isArray(snapshot) && snapshot.find(j => String(j.id) === idJogoUnico)) {
                        res.writeHead(409, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({ ok: false, erro: 'Jogo já iniciado' }));
                        return;
                    }
                    // _callbackAdicionarJogo is a shared mutable holder: { fn: Function|null }
                    if (_callbackAdicionarJogo && typeof _callbackAdicionarJogo.fn === 'function') {
                        // O callback agora pode retornar um objeto { ok: boolean, erro?: string, id?: string }
                        let resultado = await _callbackAdicionarJogo.fn(url);
                        // Compatibilidade: se callback não retornar nada, consideramos OK
                        if (resultado === undefined) resultado = { ok: true };

                        if (resultado && resultado.ok) {
                            res.writeHead(200, { 'Content-Type': 'application/json' });
                            res.end(JSON.stringify({ ok: true, id: resultado.id || null }));
                        } else {
                            // Se o jogo já existe, retornamos 409 Conflict
                            res.writeHead(409, { 'Content-Type': 'application/json' });
                            res.end(JSON.stringify({ ok: false, erro: resultado && resultado.erro ? resultado.erro : 'Jogo já iniciado' }));
                        }
                    } else {
                        res.writeHead(503, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({ ok: false, erro: 'Engine ainda não pronta' }));
                    }
                } catch (e) {
                    res.writeHead(500, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ ok: false, erro: e.message }));
                }
            });
            return; // we've set up the POST body handlers; don't fall through to 404

        } else {
            // Try serving report page or reports assets before returning 404
            try {
                if ((req.url === '/report' || req.url === '/report.html') && req.method === 'GET') {
                    const filePath = path.join(__dirname, 'report.html');
                    if (fs.existsSync(filePath)) {
                        const data = fs.readFileSync(filePath);
                        res.writeHead(200, { 'Content-Type': 'text/html' }); res.end(data);
                    } else {
                        res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('report.html not found');
                    }
                    return;
                }
                if (req.url.startsWith('/reports/') && req.method === 'GET') {
                    const rel = req.url.replace(/^\/reports\//, '');
                    const filePath = path.join(__dirname, 'reports', rel);
                    if (!fs.existsSync(filePath)) { res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('Not found'); return; }
                    const ext = path.extname(filePath).toLowerCase();
                    let mime = 'application/octet-stream';
                    if (ext === '.json') mime = 'application/json';
                    else if (ext === '.csv') mime = 'text/csv';
                    else if (ext === '.html') mime = 'text/html';
                    const data = fs.readFileSync(filePath);
                    res.writeHead(200, { 'Content-Type': mime, 'Cache-Control': 'no-cache' }); res.end(data);
                    return;
                }
            } catch (e) {
                // proceed to default 404
            }
            res.writeHead(404); res.end();
        }
    });

    // Serve report page and report assets (JSON/CSV) from /reports
    // We add a small helper: if a request for /report or /reports/* arrives, serve the file early.
    // This runs inside the module scope so 'server' is accessible.
    server.on('request', (req, res) => {
        try {
            if ((req.url === '/report' || req.url === '/report.html') && req.method === 'GET') {
                const filePath = path.join(__dirname, 'report.html');
                if (fs.existsSync(filePath)) {
                    const data = fs.readFileSync(filePath);
                    res.writeHead(200, { 'Content-Type': 'text/html' }); res.end(data);
                } else {
                    res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('report.html not found');
                }
                return;
            }

            if (req.url.startsWith('/reports/') && req.method === 'GET') {
                const rel = req.url.replace(/^\/reports\//, '');
                const filePath = path.join(__dirname, 'reports', rel);
                if (!fs.existsSync(filePath)) { res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('Not found'); return; }
                const ext = path.extname(filePath).toLowerCase();
                let mime = 'application/octet-stream';
                if (ext === '.json') mime = 'application/json';
                else if (ext === '.csv') mime = 'text/csv';
                else if (ext === '.html') mime = 'text/html';
                const data = fs.readFileSync(filePath);
                res.writeHead(200, { 'Content-Type': mime, 'Cache-Control': 'no-cache' }); res.end(data);
                return;
            }
        } catch (e) {
            // do not crash on errors here; main handler will handle or return 404
        }
    });

    if (process.env.DISABLE_HTTP !== '1') {
        server.listen(3000, '0.0.0.0', () => {});
    }
 }
