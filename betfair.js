// betfair.js — Integração via The Odds API (theOddsAPI.com)
// ✅ Sem restrição geográfica — funciona no Brasil
// ✅ Fornece odds Back + Lay da Betfair Exchange e outros bookmakers
// Registo gratuito: https://the-odds-api.com  (500 req/mês grátis)

const axios = require('axios');
const config = require('./config');

const API_BASE = 'https://api.the-odds-api.com/v4';

// Cache de quota (monitoramento de requests restantes)
let _requestsRestantes = null;

// Cache das ligas disponíveis na API (atualizado 1 vez por sessão)
let _ligasDisponiveis = null;

// Ligas preferidas por ordem de prioridade — usadas como filtro se disponíveis
const LIGAS_PREFERIDAS = [
    'soccer_epl', 'soccer_spain_la_liga', 'soccer_germany_bundesliga',
    'soccer_italy_serie_a', 'soccer_france_ligue_one',
    'soccer_brazil_campeonato', 'soccer_brazil_serie_b',
    'soccer_argentina_primera_division', 'soccer_conmebol_copa_libertadores',
    'soccer_netherlands_eredivisie', 'soccer_portugal_primeira_liga',
    'soccer_sweden_allsvenskan', 'soccer_norway_eliteserien',
    'soccer_finland_veikkausliiga', 'soccer_denmark_superliga',
    'soccer_turkey_super_league', 'soccer_belgium_first_div',
    'soccer_scotland_premiership', 'soccer_england_championship',
    'soccer_russia_premier_league', 'soccer_austria_bundesliga',
    'soccer_switzerland_superleague', 'soccer_poland_ekstraklasa',
    'soccer_czech_republic_first_league',
    'soccer_colombia_primera_a', 'soccer_chile_primera_division',
    'soccer_peru_primera_division', 'soccer_uruguay_primera_division',
    'soccer_venezuela_primera', 'soccer_bolivia_primera_division',
    'soccer_ecuador_primera_a', 'soccer_paraguay_primera_division',
    'soccer_mexico_ligamx', 'soccer_usa_mls',
    'soccer_japan_j_league', 'soccer_australia_aleague',
    'soccer_south_korea_kleague1', 'soccer_greece_super_league',
    'soccer_romania_1', 'soccer_serbia_superliga',
    'soccer_uefa_champs_league', 'soccer_uefa_europa_league',
    'soccer_uefa_europa_conference_league'
];

// ─────────────────────────────────────────────────────────────────
// UTILITÁRIOS
// ─────────────────────────────────────────────────────────────────
function _norm(str) {
    return (str || '').toLowerCase()
        .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
        .replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
}

function _scoreSimilaridade(homeApi, awayApi, nomeCasa, nomeFora) {
    const t  = `${_norm(homeApi)} ${_norm(awayApi)}`;
    const c  = _norm(nomeCasa).split(' ').filter(p => p.length > 2);
    const f  = _norm(nomeFora).split(' ').filter(p => p.length > 2);
    let score = 0;
    c.forEach(p => { if (t.includes(p)) score += 2; });
    f.forEach(p => { if (t.includes(p)) score += 2; });
    return score;
}

function _extrairOdds(bookmakers, nomeCasa, nomeFora) {
    if (!bookmakers || bookmakers.length === 0) return null;

    // Prefere Betfair Exchange, senão usa o primeiro bookmaker disponível
    const bf = bookmakers.find(b => b.key === 'betfair_ex_eu' || b.key === 'betfair_ex_uk')
            || bookmakers[0];

    if (!bf) return null;

    const h2h    = bf.markets?.find(m => m.key === 'h2h');
    const h2hLay = bf.markets?.find(m => m.key === 'h2h_lay');

    const obterPreco = (market, nome) => {
        if (!market) return null;
        const o = market.outcomes?.find(x =>
            _norm(x.name).includes(_norm(nome).split(' ')[0]) ||
            _norm(nome).includes(_norm(x.name).split(' ')[0])
        );
        return o ? parseFloat(o.price.toFixed(2)) : null;
    };

    const obterDraw = (market) => {
        if (!market) return null;
        const o = market.outcomes?.find(x => _norm(x.name) === 'draw');
        return o ? parseFloat(o.price.toFixed(2)) : null;
    };

    return {
        oddCasaBack:   obterPreco(h2h,    nomeCasa),
        oddCasaLay:    obterPreco(h2hLay, nomeCasa),
        oddEmpateBack: obterDraw(h2h),
        oddEmpateLay:  obterDraw(h2hLay),
        oddForaBack:   obterPreco(h2h,    nomeFora),
        oddForaLay:    obterPreco(h2hLay, nomeFora),
        bookmaker:     bf.title,
        statusMercado: 'OPEN'
    };
}

// ─────────────────────────────────────────────────────────────────
// CHAMADA À API (com controlo de quota)
// ─────────────────────────────────────────────────────────────────
async function _get(path, params = {}) {
    if (!config.ODDS_API_KEY || config.ODDS_API_KEY === 'SUA_ODDS_API_KEY_AQUI') return null;

    try {
        const res = await axios.get(`${API_BASE}${path}`, {
            params: { apiKey: config.ODDS_API_KEY, ...params },
            timeout: 8000
        });

        // Monitorar quota restante
        const restantes = res.headers['x-requests-remaining'];
        if (restantes !== undefined) {
            _requestsRestantes = parseInt(restantes);
            if (_requestsRestantes < 50) {
                process.stderr.write(`[ODDS API] ⚠️ Quota baixa: ${_requestsRestantes} requests restantes\n`);
            }
        }

        return res.data;
    } catch (e) {
        if (e.response?.status === 401) {
            process.stderr.write('[ODDS API] ❌ API Key inválida — verifica config.js\n');
        } else if (e.response?.status === 429) {
            process.stderr.write('[ODDS API] ❌ Quota esgotada — aguarda renovação mensal\n');
        } else if (e.response?.status === 404) {
            return null; // Liga não existe ou sem eventos — silencioso (esperado)
        } else {
            process.stderr.write(`[ODDS API] ❌ Erro: ${e.message}\n`);
        }
        return null;
    }
}

// ─────────────────────────────────────────────────────────────────
// OBTÉM LISTA DE LIGAS DISPONÍVEIS NA API (1 request, cached)
// Garante que só pesquisamos ligas que realmente existem
// ─────────────────────────────────────────────────────────────────
async function _obterLigasDisponiveis() {
    if (_ligasDisponiveis) return _ligasDisponiveis;

    const data = await _get('/sports/', { all: false }); // all=false → só ligas com eventos activos
    if (!Array.isArray(data)) {
        // Fallback: usa lista preferida sem validação
        _ligasDisponiveis = LIGAS_PREFERIDAS;
        return _ligasDisponiveis;
    }

    // Filtra só ligas de futebol disponíveis, cruzando com as preferidas
    const keysDisponiveis = new Set(data.filter(s => s.group === 'Soccer').map(s => s.key));
    _ligasDisponiveis = LIGAS_PREFERIDAS.filter(k => keysDisponiveis.has(k));

    process.stdout.write(`[ODDS API] ✅ ${_ligasDisponiveis.length} ligas de futebol disponíveis\n`);
    return _ligasDisponiveis;
}

// ─────────────────────────────────────────────────────────────────
// BUSCA O EVENTO AO VIVO POR NOME DAS EQUIPAS
// Pesquisa ligas em grupos para poupar requests
// Retorna: { sportKey, eventId } ou null
// ─────────────────────────────────────────────────────────────────
async function buscarMercadoPartida(nomeTimeCasa, nomeTimeFora) {
    if (!config.ODDS_API_KEY || config.ODDS_API_KEY === 'SUA_ODDS_API_KEY_AQUI') return null;

    // Obtém apenas ligas que existem na API (evita 404)
    const ligas = await _obterLigasDisponiveis();

    const GRUPO_SIZE = 3;
    let melhorEvento = null;
    let melhorScore  = 0;

    for (let i = 0; i < ligas.length; i += GRUPO_SIZE) {
        const grupo = ligas.slice(i, i + GRUPO_SIZE);

        const resultados = await Promise.all(
            grupo.map(liga =>
                _get(`/sports/${liga}/odds/`, {
                    regions:    'eu,uk',
                    markets:    'h2h',
                    oddsFormat: 'decimal'
                }).then(data => ({ liga, data })).catch(() => ({ liga, data: null }))
            )
        );

        for (const { liga, data } of resultados) {
            if (!Array.isArray(data)) continue;
            for (const evento of data) {
                const score = _scoreSimilaridade(evento.home_team, evento.away_team, nomeTimeCasa, nomeTimeFora);
                if (score > melhorScore) {
                    melhorScore   = score;
                    melhorEvento  = { sportKey: liga, eventId: evento.id, homeTeam: evento.home_team, awayTeam: evento.away_team };
                }
            }
        }

        if (melhorScore >= 4) break; // Encontrado — para de pesquisar
        await new Promise(r => setTimeout(r, 300)); // Pequeno delay entre grupos
    }

    if (melhorScore >= 4) {
        process.stdout.write(`[ODDS API] ✅ Evento encontrado: ${melhorEvento.homeTeam} v ${melhorEvento.awayTeam} (score: ${melhorScore})\n`);
        return melhorEvento;
    }

    process.stderr.write(`[ODDS API] ⚠️ Evento não encontrado para: ${nomeTimeCasa} v ${nomeTimeFora}\n`);
    return null;
}

// ─────────────────────────────────────────────────────────────────
// BUSCA AS ODDS ATUAIS DE UM EVENTO ESPECÍFICO
// 1 request por chamada — chamar a cada 60 segundos por jogo
// ─────────────────────────────────────────────────────────────────
async function buscarOddsAtuais(marketInfo) {
    if (!marketInfo?.sportKey || !marketInfo?.eventId) return null;

    const data = await _get(`/sports/${marketInfo.sportKey}/odds/`, {
        regions:    'eu,uk',
        markets:    'h2h,h2h_lay',
        oddsFormat: 'decimal',
        eventIds:   marketInfo.eventId
    });

    if (!Array.isArray(data) || data.length === 0) return null;

    const evento = data[0];
    return _extrairOdds(evento.bookmakers, marketInfo.homeTeam, marketInfo.awayTeam);
}

function getRequestsRestantes() { return _requestsRestantes; }

module.exports = { buscarMercadoPartida, buscarOddsAtuais, getRequestsRestantes };
