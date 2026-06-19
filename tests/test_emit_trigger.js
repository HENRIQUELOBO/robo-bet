const fs = require('fs').promises;
const path = require('path');
const { formatarDataHora } = require('../util');

(async () => {
  try {
    const CAMINHO_LOG_CSV = path.join(__dirname, 'historico_gatilhos.csv');
    try { await fs.access(CAMINHO_LOG_CSV); } catch (e) {
      const header = 'DATA_HORA;PARTIDA;METODO;TEMPO_DISPARO;PLACAR_MOMENTO;APM_MOMENTO;XG_MAX_MOMENTO;QUALIDADE_SINAL;\n';
      await fs.writeFile(CAMINHO_LOG_CSV, header, 'utf8');
    }

    const jogo = {
      nomePartida: 'Yeronga Eagles FC v University Of Queensland',
      tempo: 37,
      placar: '0-0',
      pressao: 2.34,
      xgCasa: 0.12,
      xgFora: 0.05,
      momentum: { ataquesCasa: 3, ataquesFora: 1 }
    };

    const matchQual = ("GATILHO_TESTE").match(/Qualidade(?:\s+m[aá]x)?:\s*(\d+)%/i);
    const qualidadeSinal = matchQual ? `${matchQual[1]}%` : 'N/D';
    const { data: dataHoje, hora: horaAgora } = formatarDataHora();
    const linha = `${dataHoje} ${horaAgora};${jogo.nomePartida.replace(/;/g,'-')};GATILHO_TESTE;${jogo.tempo};${jogo.placar};${jogo.pressao.toFixed(2)};${Math.max(jogo.xgCasa,jogo.xgFora).toFixed(2)};${qualidadeSinal};\n`;

    await fs.appendFile(CAMINHO_LOG_CSV, linha, 'utf8');
    console.log('Gatilho de teste gravado no CSV.');
  } catch (err) {
    console.error('Erro no teste:', err);
    process.exitCode = 1;
  }
})();
