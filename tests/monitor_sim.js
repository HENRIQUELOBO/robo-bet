// simple simulation to test monitor_results behavior
const logger = require('../logger');

async function run() {
  // create a fake jogo and send an alert (this will append to CSV and register pendente)
  const jogo = { id: 'test_game_1', nomePartida: 'Lanús v San Luis FC', tempo: 51, placar: '0-0', pressao: 2.0, xgCasa: 1.5, xgFora: 1.0, momentum: { escanteiosCasa:1, escanteiosFora:2, ataquesCasa:0, ataquesFora:0 } };
  await logger.enviarAlertaTelegram(jogo.id, jogo, 'Teste LAY_DRAW', 'LAY_DRAW');

  // Now simulate a goal for the away team (Lanús home? depending on naming, we'll change placar to 0-1)
  const pool = new Map();
  const jogoAtualizado = { ...jogo, tempo: 52, placar: '0-1', noIntervalo: false };
  pool.set(jogo.id, jogoAtualizado);
  // call atualizarDadosPainelWeb to notify monitor
  logger.atualizarDadosPainelWeb(pool, new Map());

  console.log('Simulação concluída. Verifique historico_gatilhos.csv para ver se o PENDING virou RED/GREEN corretamente.');
}

run().catch(e=>{ console.error(e); process.exit(1); });

