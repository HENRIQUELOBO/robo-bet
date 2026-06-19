// tests/engine_quant.test.js

jest.mock('../logger', () => ({
  enviarAlertaTelegram: jest.fn()
}));

const logger = require('../logger');
const { processarMotorDeRegras } = require('../engine_quant');

function makeJogoForGatilho1T() {
  const minAtual = 25; // dentro da janela 15-40
  // criamos historicos com muitos eventos no minuto atual para contar como pressão
  const repet = (n) => Array(n).fill(minAtual);
  const jogo = {
    tempo: minAtual,
    nomePartida: 'Time A x Time B',
    placar: '0-0',
    noIntervalo: false,
    momentumResetado2T: false,
    posseBolaCasa: 55,
    historicoAtqCasa: repet(12),
    historicoAtqFora: repet(2),
    historicoEscCasa: [],
    historicoEscFora: [],
    historicoChAlvoCasa: [minAtual, minAtual],
    historicoChAlvoFora: [],
    historicoChForaCasa: [],
    historicoChForaFora: [],
    betfairOdds: null
  };
  // prepare momentum object shape expected
  jogo.momentum = {
    ataquesCasa: 0, ataquesFora: 0, escanteiosCasa: 0, escanteiosFora: 0,
    chutesNoAlvoCasa: 0, chutesNoAlvoFora: 0, chutesParaForaCasa: 0, chutesParaForaFora: 0
  };
  return jogo;
}

test('GATILHO 1T CASA dispara quando condições são satisfeitas', () => {
  const idJogo = 'teste1';
  const jogo = makeJogoForGatilho1T();
  const alertas = {
    golIminente1T: false
  };

  processarMotorDeRegras(idJogo, jogo, alertas);

  expect(alertas.golIminente1T).toBe(true);
  expect(logger.enviarAlertaTelegram).toHaveBeenCalled();
  // último argumento do envio é a tag do gatilho
  const calledWith = logger.enviarAlertaTelegram.mock.calls[0];
  expect(calledWith[3]).toBe('GATILHO_1T');
});

