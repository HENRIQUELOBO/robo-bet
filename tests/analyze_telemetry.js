const fs = require('fs');
const path = require('path');
const engine = require('../engine_quant');

const TELE_DIR = path.join(__dirname, '..', 'log', 'telemetria');
const OUT_DIR = path.join(__dirname, '..', 'reports');
if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });

function parseLine(line) {
  // Example line format produced by logger:
  // [11:15:32] | Min: 51' | Placar: 0-0 | APM Max: 1.23 | xG C: 0.50 - xG F: 0.40 | Esc: 1/0 | APM10m C/F: 12/3
  const rMin = /Min:\s*(\d+)'/i.exec(line);
  const rPlacar = /Placar:\s*([0-9]+-[0-9]+)/i.exec(line);
  const rAPM = /APM Max:\s*([0-9.]+)/i.exec(line);
  const rxg = /xG C:\s*([0-9.]+)\s*-\s*xG F:\s*([0-9.]+)/i.exec(line);
  const resc = /Esc:\s*(\d+)\/(\d+)/i.exec(line);
  const ratk = /APM10m C\/F:\s*(\d+)\/(\d+)/i.exec(line);

  const tempo = rMin ? Number(rMin[1]) : null;
  const placar = rPlacar ? rPlacar[1] : null;
  const apm = rAPM ? Number(rAPM[1]) : 0;
  const xgCasa = rxg ? Number(rxg[1]) : 0;
  const xgFora = rxg ? Number(rxg[2]) : 0;
  const escC = resc ? Number(resc[1]) : 0;
  const escF = resc ? Number(resc[2]) : 0;
  const atqC = ratk ? Number(ratk[1]) : 0;
  const atqF = ratk ? Number(ratk[2]) : 0;

  return { tempo, placar, apm, xgCasa, xgFora, escC, escF, atqC, atqF };
}

function buildJogoFromSnapshot(snapshot) {
  const jogo = {
    tempo: snapshot.tempo || 0,
    placar: snapshot.placar || '0-0',
    pressao: snapshot.apm || 0,
    xgCasa: snapshot.xgCasa || 0,
    xgFora: snapshot.xgFora || 0,
    historicoAtqCasa: [], historicoAtqFora: [],
    historicoEscCasa: [], historicoEscFora: [],
    historicoChAlvoCasa: [], historicoChAlvoFora: [],
    momentum: {
      ataquesCasa: snapshot.atqC || 0,
      ataquesFora: snapshot.atqF || 0,
      escanteiosCasa: snapshot.escC || 0,
      escanteiosFora: snapshot.escF || 0,
      chutesNoAlvoCasa: 0, chutesNoAlvoFora: 0
    }
  };
  return jogo;
}

async function analyze() {
  const files = fs.existsSync(TELE_DIR) ? fs.readdirSync(TELE_DIR).filter(f => f.startsWith('telemetria_')) : [];
  const report = { generatedAt: new Date().toISOString(), files: [] };
  for (const file of files) {
    const p = path.join(TELE_DIR, file);
    const lines = fs.readFileSync(p, 'utf8').split(/\r?\n/).filter(Boolean);
    const fileReport = { file, snapshots: [] };
    for (const line of lines) {
      const snap = parseLine(line);
      if (!snap.tempo) continue; // skip malformed
      const jogo = buildJogoFromSnapshot(snap);
      // prepare fresh alertas map
      const alertas = {};
      try {
        engine.processarMotorDeRegras(`tele_${file}`, jogo, alertas);
      } catch (e) {
        // if engine throws, capture and continue
        fileReport.snapshots.push({ snapshot: snap, error: e.message });
        continue;
      }
      const analysis = jogo._engineAnalysis || null;
      // determine which methods are satisfied by checking analyzer structure or alertas
      const fired = [];
      if (alertas) {
        for (const k of Object.keys(alertas)) if (alertas[k]) fired.push(k);
      }
      // create explanation: use analysis if present
      const explanation = analysis ? analysis : { note: 'no analyzer output', alertas: fired };
      fileReport.snapshots.push({ snapshot: snap, fired, explanation });
    }
    report.files.push(fileReport);
  }
  // write report JSON and summary CSV
  const outJson = path.join(OUT_DIR, 'telemetry_report.json');
  fs.writeFileSync(outJson, JSON.stringify(report, null, 2), 'utf8');
  // write compact report data for the UI (smaller, contains only what's needed)
  try {
    const compact = { generatedAt: report.generatedAt, files: [] };
    for (const f of report.files) {
      const fr = { file: f.file, snapshots: [] };
      for (const s of f.snapshots) {
        const snap = s.snapshot || {};
        const fired = s.fired || [];
        const analysis = s.explanation && typeof s.explanation === 'object' ? s.explanation : (s.explanation && s.explanation.alertas ? { alertas: s.explanation.alertas } : {});
        // compact per-method info
        const methods = {};
        if (analysis && typeof analysis === 'object') {
          for (const key of Object.keys(analysis)) {
            const v = analysis[key];
            if (v && typeof v === 'object') {
              methods[key] = {
                confidence: v.confidence || v.conf || null,
                criteria: Array.isArray(v.criteria) ? v.criteria : (Array.isArray(v.satisfied) || Array.isArray(v.missing) ? Array.from(new Set([...(v.satisfied||[]), ...(v.missing||[])])).slice(0,50) : []) ,
                satisfied: Array.isArray(v.satisfied) ? v.satisfied : [],
                missing: Array.isArray(v.missing) ? v.missing : []
              };
            }
          }
        }
        fr.snapshots.push({ snapshot: { tempo: snap.tempo, placar: snap.placar, partida: snap.partida || snap.nomePartida || null }, fired, methods });
      }
      compact.files.push(fr);
    }
    fs.writeFileSync(path.join(OUT_DIR, 'telemetry_report_compact.json'), JSON.stringify(compact, null, 2), 'utf8');
  } catch (e) {
    console.error('Failed to write compact report:', e.message);
  }
  // summary CSV
  const csvLines = ['file,minuto,placar,fired_methods'];
  for (const f of report.files) {
    for (const s of f.snapshots) {
      const minuto = (s.snapshot && s.snapshot.tempo) || '';
      const placar = (s.snapshot && s.snapshot.placar) || '';
      const fired = (s.fired || []).join('|');
      csvLines.push([f.file, minuto, placar, fired].join(','));
    }
  }
  fs.writeFileSync(path.join(OUT_DIR, 'telemetry_summary.csv'), csvLines.join('\n'), 'utf8');
  console.log('Report written to', outJson, 'and summary CSV in reports/');
}

if (require.main === module) {
  analyze().catch(e => { console.error('Analyze failed:', e); process.exit(1); });
}

module.exports = { analyze };

