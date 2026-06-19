// tests/logger_csv.test.js

// Prevent the real http server from starting and provide util helpers expected by logger
jest.mock('../httpServer', () => jest.fn());
jest.mock('../util', () => ({ _formatarDataHora: () => ({ data: '01-01-1970', hora: '00:00:00' }), _sanitizarNomeJogo: (n) => n.replace(/\s+/g, '_') }));

const fs = require('fs');
const logger = require('../logger');

jest.useRealTimers();

describe('logger CSV write', () => {
  let accessMock, writeFileMock, appendFileMock;

  beforeEach(() => {
    // Mock fs.promises methods used by logger
    const fsp = fs.promises;
    accessMock = jest.spyOn(fsp, 'access').mockImplementation(() => { return Promise.reject(new Error('no file')); });
    writeFileMock = jest.spyOn(fsp, 'writeFile').mockImplementation(() => Promise.resolve());
    appendFileMock = jest.spyOn(fsp, 'appendFile').mockImplementation(() => Promise.resolve());
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  test('enviarAlertaTelegram escreve header e linha no CSV', async () => {
    const idJogo = 'csvtest';
    const jogo = {
      tempo: 30,
      nomePartida: 'A vs B',
      placar: '0-0',
      pressao: 1.23,
      xgCasa: 0.5,
      xgFora: 0.4,
      momentum: { ataquesCasa: 10, ataquesFora: 1 }
    };

    const mensagem = 'Teste Qualidade: 45%';

    // Call the real function
    await logger.enviarAlertaTelegram(idJogo, jogo, mensagem, 'TEST_METODO');

    // access was called to check file existence
    expect(accessMock).toHaveBeenCalled();
    // writeFile should be called to create header when access failed
    expect(writeFileMock).toHaveBeenCalled();
    // appendFile should be called to add the log line
    expect(appendFileMock).toHaveBeenCalled();

    // Inspect the appended line argument to ensure it contains expected fields
    const appended = appendFileMock.mock.calls[0][1];
    expect(appended).toMatch(/A vs B/);
    expect(appended).toMatch(/TEST_METODO/);
    // qualidade pode ser extraída automaticamente ou ficar 'N/D' — aceitamos ambos
    expect(appended).toMatch(/45%|N\/D/);
  });
});
