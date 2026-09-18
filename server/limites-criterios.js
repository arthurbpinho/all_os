// Quantos critérios uma régua do avaliador oficial pode ter (demandas.md §16.6).
//
// Eram exatamente 8 (o octógono do v34). Com "Adicionar critério" o número
// passou a ser do admin, dentro de uma faixa: menos de 3 não faz radar nem
// avaliação que valha, e cada critério é uma chamada de IA a mais por sessão
// avaliada — 16 já dobra o custo de hoje.
module.exports = { min: 3, max: 16 };
