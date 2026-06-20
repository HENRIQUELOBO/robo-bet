const fs = require('fs');
const path = require('path');
const csvPath = path.join(__dirname, '..', 'historico_gatilhos.csv');
function applyConfirmation(id, novo) {
  const txt = fs.readFileSync(csvPath,'utf8');
  const lines = txt.split(/\r?\n/);
  if (id<1 || id>lines.length) return false;
  if (!lines[id-1] || lines[id-1].trim()==='') return false;
  const cols = lines[id-1].split(';').map(c=>c);
  let idCol = cols.findIndex(c => typeof c === 'string' && c.trim().startsWith('sig_'));
  if (idCol !== -1) {
    const statusCol = Math.max(0, idCol-1);
    cols[statusCol] = novo;
    cols.splice(statusCol + 1);
  } else {
    for (let i=cols.length-1;i>=0;i--) {
      if (cols[i] && cols[i].trim() !== '') { cols[i]=novo; break; }
    }
  }
  if (cols[cols.length-1] !== '') cols.push('');
  lines[id-1] = cols.join(';');
  fs.writeFileSync(csvPath, lines.join('\n'),'utf8');
  return true;
}
console.log('before:\n', fs.readFileSync(csvPath,'utf8'));
const ok = applyConfirmation(6,'RED');
console.log('applied?', ok);
console.log('after:\n', fs.readFileSync(csvPath,'utf8'));

