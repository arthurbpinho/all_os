// Análise POR CRITÉRIO de uma sessão — SÓ supervisor e admin.
//
// O avaliador oficial (v29) produz, além da nota de cada critério, uma análise
// curta em prosa. Ela é escrita por um nó que estava lendo o Bloco 1 (o gabarito
// do caso), então não pode chegar ao aluno: ele tem a nota total e o feedback
// qualitativo, que é o que o sintetizador escreveu sem ver o gabarito.
//
// Por isso este componente não recebe o conteúdo pronto — ele o BUSCA, sob
// demanda, em GET /api/logs/:id/criterios, que exige o papel no servidor. O log
// que chega ao aluno não tem nem a chave (`evalPartsId`), então nem o botão
// aparece para ele.
import { useState } from 'react';
import { api } from '../api';
import RichText from './RichText';

// Nome de cada faixa da régua, para o supervisor ler a nota sem decorar a
// tabela. As notas pares são a faixa "completa"; as ímpares, "incompleta".
const FAIXAS = {
  1: 'Erro',
  2: 'Clichê',
  3: 'Potente',
  4: 'Precisa',
  5: 'Excepcional',
};

export default function CriteriaAnalyses({ log }) {
  const [aberto, setAberto] = useState(false);
  const [dados, setDados] = useState(null);
  const [carregando, setCarregando] = useState(false);
  const [erro, setErro] = useState('');

  // Sem chave não há o que buscar: log antigo (avaliador de prompt único) ou
  // um log servido a aluno, de onde o campo é removido no servidor.
  if (!log || !log.evalPartsId) return null;

  async function abrir() {
    setAberto(true);
    if (dados || carregando) return;
    setCarregando(true);
    setErro('');
    try {
      const d = await api.logCriterios(log.id);
      if (!d || !d.disponivel) setErro((d && d.motivo) || 'Detalhe indisponível.');
      else setDados(d);
    } catch (e) {
      setErro(e.message || 'Não foi possível carregar as análises por critério.');
    } finally {
      setCarregando(false);
    }
  }

  if (!aberto) {
    return (
      <button type="button" className="btn btn-outline" onClick={abrir} style={{ marginBottom: 14, fontSize: 12.5, padding: '4px 12px' }}>
        Ver análise por critério
      </button>
    );
  }

  return (
    <div className="criteria-analyses">
      <div className="criteria-analyses-head">
        <span>
          Análise por critério
          <em> (visível só ao supervisor/admin)</em>
        </span>
        <button type="button" className="btn btn-ghost" onClick={() => setAberto(false)} style={{ fontSize: 12, padding: '2px 10px' }}>
          Recolher
        </button>
      </div>

      {carregando && <p className="criteria-analyses-msg">Carregando…</p>}
      {erro && <p className="criteria-analyses-msg erro">{erro}</p>}

      {dados && (
        <>
          <div className="criteria-analyses-meta">
            {dados.version}
            {dados.model ? ` · ${dados.model}` : ''}
            {dados.effort ? `/${dados.effort}` : ''}
            {dados.batch ? ' · batch' : ''}
            {dados.notaFinal != null ? ` · nota ${dados.notaFinal}/100` : ''}
          </div>

          {dados.missao && (
            <div className={`criteria-missao ${dados.missao.cumprida ? 'ok' : 'nao'}`}>
              <strong>Missão {dados.missao.cumprida ? 'cumprida' : 'não cumprida'}</strong>
              {dados.missao.justificativa ? <div>{dados.missao.justificativa}</div> : null}
            </div>
          )}

          {dados.partes.map((p) => (
            <div key={p.num} className={`criteria-parte${p.incluido ? '' : ' fora'}`}>
              <div className="criteria-parte-top">
                <strong>{p.num}. {p.nome}</strong>
                <span className="criteria-parte-nota">
                  {p.nota != null ? `${p.nota}/10` : 'sem nota'}
                  {p.faixa ? ` · ${FAIXAS[p.faixa] || `F${p.faixa}`}${p.realizacao ? ` (${p.realizacao})` : ''}` : ''}
                </span>
              </div>
              {p.linhaCurta && <div className="criteria-parte-linha">{p.linhaCurta}</div>}
              {p.analise
                ? <div className="criteria-parte-analise"><RichText text={p.analise} /></div>
                : <div className="criteria-parte-analise vazio">(o nó não devolveu análise para este critério)</div>}
              {p.travasInconsistentes && (
                <div className="criteria-parte-aviso">Trava aberta acima de uma fechada — descartada pelo código.</div>
              )}
              {!p.incluido && (
                <div className="criteria-parte-aviso">Fora da nota final (sem nota legível).</div>
              )}
            </div>
          ))}
        </>
      )}
    </div>
  );
}
