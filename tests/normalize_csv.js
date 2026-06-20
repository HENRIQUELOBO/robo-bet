const fs = require('fs');
const path = require('path');
const csvPath = path.join(__dirname, '..', 'historico_gatilhos.csv');
let txt = fs.readFileSync(csvPath, 'utf8');
const lines = txt.split(/\r?\n/);
const out = [];
for (let ln of lines) {
  if (!ln || ln.trim()==='') { out.push(ln); continue; }
  // strip any leading "N | " prefixes by finding date
  const m = ln.match(/\d{2}-\d{2}-\d{4}/);
  if (m) ln = ln.slice(m.index);
  const cols = ln.split(';');
  // if we have PENDING followed by RED/GREEN, remove the earlier PENDING
  for (let i=0;i<cols.length-1;i++) {
    const a = (cols[i]||'').trim().toUpperCase();
    const b = (cols[i+1]||'').trim().toUpperCase();
    if (a === 'PENDING' && (b === 'RED' || b === 'GREEN')) {
      // remove the PENDING by shifting left: set cols[i] = '' (so later logic finds last token)
      cols.splice(i,1);
      break;
    }
  }
  out.push(cols.join(';'));
}
fs.writeFileSync(csvPath, out.join('\n'), 'utf8');
console.log('normalized historico_gatilhos.csv');

