// Análise POR CRITÉRIO de uma sessão — SÓ supervisor e admin.
//
// O avaliador oficial (v34) produz, além da nota de cada critério, as cinco
// qualidades que a somaram e uma análise curta em prosa. A análise é escrita por
// um nó que estava lendo o Bloco 1 (o gabarito do caso), então não pode chegar
// ao aluno: ele tem a nota total e o feedback qualitativo, que é o que o
// sintetizador escreveu sem ver o gabarito.
//
// Por isso este componente não recebe o conteúdo pronto — ele o BUSCA, sob
// demanda, em GET /api/logs/:id/criterios (ou /api/duel/:id/criterios), que
// exige o papel no servidor. O log que chega ao aluno não tem nem a chave
// (`evalPartsId`), então nem o botão aparece para ele.
//
// Duas formas de resultado convivem aqui, e a diferença vem da entrada do v34:
//   · individual (Treinamento, Competitivo, Seletivo, Visitante, correção
//     manual) — uma nota e um conjunto de cinco qualidades por critério;
//   · comparativa (Duelo) — duas notas e dois conjuntos, um por aluno.
// Runs ANTIGAS, de régua de trava, trazem `faixa` no lugar das qualidades; o
// histórico ainda é servido, então a tela continua sabendo desenhá-las.
import { useState } from 'react';
import { api } from '../api';
import RichText from './RichText';

// As cinco qualidades, na ordem do prompt. É a ordem em que o nó as escreve e a
// ordem em que elas vão ao sintetizador.
const QUALIDADES = [
  ['integridade', 'Integridade'],
  ['autoria', 'Autoria'],
  ['potencia', 'Potência'],
  ['calibracao', 'Calibração'],
  ['excepcionalidade', 'Excepcionalidade'],
];

// Runs antigas: o nome de cada faixa da régua de trava, para o supervisor ler a
// nota sem decorar a tabela. As notas pares eram a faixa "completa"; as ímpares,
// "incompleta".
const FAIXAS = {
  1: 'Erro',
  2: 'Clichê',
  3: 'Potente',
  4: 'Precisa',
  5: 'Excepcional',
};

function Qualidades({ valores }) {
  if (!valores) return null;
  return (
    <div className="criteria-quals">
      {QUALIDADES.map(([chave, rotulo]) => (
        <span key={chave} className={`criteria-qual ${valores[chave] || 'na'}`} title={`${rotulo}: ${valores[chave] || 'não veio'}`}>
          <span className="criteria-qual-nome">{rotulo}</span>
          <span className="criteria-qual-val">{valores[chave] || '—'}</span>
        </span>
      ))}
    </div>
  );
}

export default function CriteriaAnalyses({ log, duelId }) {
  const [aberto, setAberto] = useState(false);
  const [dados, setDados] = useState(null);
  const [carregando, setCarregando] = useState(false);
  const [erro, setErro] = useState('');

  // Sem chave não há o que buscar: log antigo (avaliador de prompt único) ou
  // um log servido a aluno, de onde o campo é removido no servidor. No duelo o
  // `log` é o `result` do duelo, que carrega a mesma chave.
  if (!log || !log.evalPartsId) return null;

  async function abrir() {
    setAberto(true);
    if (dados || carregando) return;
    setCarregando(true);
    setErro('');
    try {
      const d = duelId ? await api.duelCriterios(duelId) : await api.logCriterios(log.id);
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

  // Duelo: os lados vêm do comparativo, e é ele que diz de quem é cada conjunto.
  const lados = dados && dados.comparativo ? Object.keys(dados.comparativo.notas) : null;

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
            {lados ? ` · ${lados.map((l) => `Aluno ${l} ${dados.comparativo.notas[l] == null ? '—' : `${dados.comparativo.notas[l]}/100`}`).join(' × ')}` : ''}
          </div>

          {dados.missao && (
            <div className={`criteria-missao ${dados.missao.cumprida ? 'ok' : 'nao'}`}>
              <strong>Missão {dados.missao.cumprida ? 'cumprida' : 'não cumprida'}</strong>
              {dados.missao.justificativa ? <div>{dados.missao.justificativa}</div> : null}
            </div>
          )}

          {dados.partes.map((p) => {
            // `incluido` é booleano nas runs individuais e um mapa por lado no
            // duelo. Fora da nota dos DOIS é o que marca o card inteiro.
            const foraDeTudo = lados
              ? lados.every((l) => !(p.incluido || {})[l])
              : !p.incluido;
            return (
              <div key={p.num} className={`criteria-parte${foraDeTudo ? ' fora' : ''}`}>
                <div className="criteria-parte-top">
                  <strong>{p.num}. {p.nome}</strong>
                  <span className="criteria-parte-nota">
                    {lados
                      ? lados.map((l) => `${l}: ${p.notas && Number.isFinite(p.notas[l]) ? `${p.notas[l]}/10` : '—'}`).join('  ·  ')
                      : p.nota != null ? `${p.nota}/10` : 'sem nota'}
                    {p.faixa ? ` · ${FAIXAS[p.faixa] || `F${p.faixa}`}${p.realizacao ? ` (${p.realizacao})` : ''}` : ''}
                  </span>
                </div>
                {p.linhaCurta && <div className="criteria-parte-linha">{p.linhaCurta}</div>}
                {lados
                  ? lados.map((l) => (
                    <div key={l} className="criteria-parte-lado">
                      <span className="criteria-parte-lado-nome">Aluno {l}</span>
                      <Qualidades valores={(p.qualidades || {})[l]} />
                    </div>
                  ))
                  : <Qualidades valores={p.qualidades} />}
                {p.analise
                  ? <div className="criteria-parte-analise"><RichText text={p.analise} /></div>
                  : <div className="criteria-parte-analise vazio">(o nó não devolveu análise para este critério)</div>}
                {p.qualidadesFaltantes && (
                  <div className="criteria-parte-aviso">
                    O nó não devolveu {p.qualidadesFaltantes.join(', ')} — sem as cinco não há soma, e o critério ficou fora da nota.
                  </div>
                )}
                {p.travasInconsistentes && (
                  <div className="criteria-parte-aviso">Trava aberta acima de uma fechada — descartada pelo código.</div>
                )}
                {foraDeTudo && (
                  <div className="criteria-parte-aviso">Fora da nota final (sem nota legível).</div>
                )}
              </div>
            );
          })}
        </>
      )}
    </div>
  );
}
