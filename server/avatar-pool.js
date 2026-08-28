// Pool de fotos padrão: as imagens que o admin sobe em Administração → Contas
// e que o app usa como avatar de quem NÃO tem foto própria — visitante (sessão
// anônima, que nunca vai ter uma) e conta que ainda não subiu a sua.
//
// Este módulo é a parte pura: teto da pool e a escolha de qual imagem cabe a
// quem. O index.js cuida do arquivo JSON (avatar-pool.json no volume) e dos
// bytes das imagens (DATA_DIR/avatar-pool/), do mesmo jeito que já faz com a
// foto dos pacientes — nada de imagem entra no git.

const MAX_FOTOS = 10;

// A escolha é DETERMINÍSTICA a partir do id: a mesma pessoa recebe sempre a
// mesma foto. "Rotacionar" aqui é espalhar as pessoas pela pool, não sortear a
// cada tela — um sorteio por requisição faria o avatar trocar entre o feed e a
// discussão, e o leitor perderia a única pista visual de que é a mesma pessoa.
//
// FNV-1a de 32 bits: barato, sem dependência e bem distribuído para ids curtos
// ("7", "visitor-a1b2c3"), que é o caso aqui. Não é hash criptográfico e não
// precisa ser — o resultado é um índice de imagem, não um segredo.
function hash32(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

// A URL da foto padrão de `chave` (id do usuário ou do visitante), ou null
// quando a pool está vazia — aí quem desenha cai no fallback de iniciais que
// já existia antes da pool.
function escolherFoto(pool, chave) {
  const lista = Array.isArray(pool) ? pool.filter((f) => f && f.url) : [];
  if (lista.length === 0 || !chave) return null;
  return lista[hash32(String(chave)) % lista.length].url;
}

// Normaliza o que está gravado no JSON. Entrada estranha (item sem url, pool
// que virou objeto) não deve derrubar a leitura do avatar de todo mundo.
function normalizarPool(bruto) {
  if (!Array.isArray(bruto)) return [];
  return bruto
    .filter((f) => f && typeof f.id === 'string' && typeof f.url === 'string')
    .slice(0, MAX_FOTOS);
}

module.exports = { MAX_FOTOS, escolherFoto, normalizarPool, hash32 };
