/**
 * Formata a data e hora atuais em um objeto com data e hora separadas.
 * @returns {{data: string, hora: string}} Objeto contendo a data formatada (DD-MM-YYYY) e a hora formatada (HH:MI:SS).
 */
function formatarDataHora() {
    const d = new Date();
    const dd  = String(d.getDate()).padStart(2, '0');
    const mm  = String(d.getMonth() + 1).padStart(2, '0');
    const yyyy = d.getFullYear();
    const hh  = String(d.getHours()).padStart(2, '0');
    const mi  = String(d.getMinutes()).padStart(2, '0');
    const ss  = String(d.getSeconds()).padStart(2, '0');
    return {
        data: `${dd}-${mm}-${yyyy}`,
        hora: `${hh}:${mi}:${ss}`
    };
}

/**
 * Sanitiza o nome de um jogo, removendo acentos, espaços e caracteres especiais.
 * @param {string} nome - O nome original do jogo.
 * @returns {string} O nome do jogo sanitizado, ou 'jogo_sem_nome' se o nome resultante for vazio.
 */
function sanitizarNomeJogo(nome) {
    // Normaliza acentos (Ö→O, ö→o, é→e, etc.) antes de remover caracteres especiais
    return nome
            .normalize('NFD')
            .replace(/[\u0300-\u036f]/g, '')
            .replace(/\s+/g, '_')
            .replace(/[^a-zA-Z0-9_]/g, '')
        || 'jogo_sem_nome';
}

module.exports = {
    formatarDataHora,
    sanitizarNomeJogo
};