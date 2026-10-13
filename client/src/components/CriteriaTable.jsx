// Notas por critério de uma sessão: radar + a lista dos critérios logo abaixo.
//
// Os NOMES vêm de `log.criterios`, que o servidor resolve pela régua ATUAL
// ("Critérios da régua" na Administração): renomeou lá, muda aqui (demandas.md
// §27). Log de avaliador antigo (neuro, v15/v16, v18.25) não tem régua no banco
// e segue com as tabelas de nomes abaixo.
//
// Cada linha traz, além da nota, as FAIXAS — a inicial de cada uma das cinco
// qualidades (verde se plena, cinza se parcial, riscada se ausente) — e a
// descrição do critério. Supervisor e admin veem, na mesma linha, a análise em
// prosa do avaliador; o aluno não, porque ela foi escrita com o gabarito do caso
// à vista. Quem decide o que cada um recebe é o servidor (GET /api/logs/:id/criterios):
// a equipe recebe o detalhe inteiro; o aluno, só os níveis, e só do próprio log.
// Desde 2026-09 o aluno também vê os NÚMEROS (se "Notas por critério e gráfico"
// estiver liberado para o perfil dele em Acessos).
import { useEffect, useState } from 'react';
import { api } from '../api';
import RadarCriterios from './RadarCriterios';
import RichText from './RichText';

// Avaliador v18.25: 15 critérios em 6 grupos. Os critérios 10 e 13 podem
// sair NA quando o caso não dá material — aí a linha simplesmente não aparece.
export const V18_CRITERIA = {
  '1': 'Precisão lexical',
  '2': 'Construção e economia',
  '3': 'Modulação da intensidade clínica',
  '4': 'Adequação à prontidão para mudança',
  '5': 'Manejo do vínculo',
  '6': 'Antifragilidade',
  '7': 'Coerência interna',
  '8': 'Coerência narrativa',
  '9': 'Ganchos verbais',
  '10': 'Ganchos não-verbais',
  '11': 'Profundidade vertical',
  '12': 'Articulação lateral',
  '13': 'Formulação',
  '14': 'Flexibilidade',
  '15': 'Criatividade',
};

// Avaliador v15/v16 (logs antigos, 6 critérios). Mantido porque o histórico não
// é reprocessado: log salvo com a grade antiga continua sendo lido com ela.
export const V15_CRITERIA = {
  '1': 'Construção linguística',
  '2': 'Relação terapêutica',
  '3': 'Confiança transmitida',
  '4': 'Priorização',
  '5': 'Aprofundamento',
  '6': 'Flexibilidade e Criatividade',
};

// Critérios do avaliador de Neuroavaliação (chaves "1".."4").
export const NEURO_CRITERIA = {
  '1': 'Acolhimento e vínculo',
  '2': 'Entrevista e investigação',
  '3': 'Raciocínio diagnóstico',
  '4': 'Indicação de testes',
};

// Nomes de um criteriaScores SEM régua no banco. Log avaliado depois de 2026-09
// traz os nomes gravados (`criteriaNames`). Fora isso: neuro tem a própria grade
// (4 critérios); e o número mais alto de critério distingue a grade de 15
// (v18.25) da de 6 (logs antigos).
export function labelsForCriteria(criteriaScores, logType, criteriaNames) {
  if (criteriaNames && typeof criteriaNames === 'object' && Object.keys(criteriaNames).length) return criteriaNames;
  if (logType === 'neuro') return NEURO_CRITERIA;
  const keys = Object.keys(criteriaScores || {}).map((k) => Number(k)).filter(Number.isFinite);
  const max = keys.length ? Math.max(...keys) : 0;
  return max > 6 ? V18_CRITERIA : V15_CRITERIA;
}

// As linhas da lista: as da régua atual, quando o servidor as resolveu; senão,
// as notas cruas com os nomes conhecidos.
export function linhasDeCriterios(log) {
  if (!log) return [];
  if (Array.isArray(log.criterios) && log.criterios.length) {
    return log.criterios.map((c) => ({ num: String(c.num), nome: c.nome, linhaCurta: c.linhaCurta || '', nota: Number(c.nota) }));
  }
  const notas = log.criteriaScores;
  if (!notas || typeof notas !== 'object') return [];
  const labels = labelsForCriteria(notas, log.type, log.criteriaNames);
  return Object.entries(notas)
    .filter(([, v]) => Number.isFinite(Number(v)))
    .sort((a, b) => Number(a[0]) - Number(b[0]))
    .map(([k, v]) => ({ num: k, nome: labels[k] || `Critério ${k}`, linhaCurta: '', nota: Number(v) }));
}

// As cinco qualidades, na ordem do avaliador.
const QUALIDADES = [
  ['integridade', 'I', 'Integridade'],
  ['autoria', 'A', 'Autoria'],
  ['potencia', 'P', 'Potência'],
  ['calibracao', 'C', 'Calibração'],
  ['excepcionalidade', 'E', 'Excepcionalidade'],
];

// Runs antigas (régua de trava) trazem `faixa` no lugar das qualidades.
const FAIXAS_ANTIGAS = { 1: 'Erro', 2: 'Clichê', 3: 'Potente', 4: 'Precisa', 5: 'Excepcional' };

// Iniciais das faixas. Sem legenda para o aluno, de propósito; a equipe ganha o
// nome por extenso ao passar o mouse.
function Faixas({ parte, equipe }) {
  if (!parte) return null;
  if (parte.qualidades) {
    return (
      <span className="faixas-aluno-iniciais">
        {QUALIDADES.filter(([k]) => parte.qualidades[k]).map(([k, inicial, rotulo]) => (
          <span key={k} className={`faixa-ini ${parte.qualidades[k]}`} title={equipe ? `${rotulo}: ${parte.qualidades[k]}` : undefined}>
            {inicial}
          </span>
        ))}
      </span>
    );
  }
  if (equipe && parte.faixa) {
    return <span className="crit-faixa-antiga">{FAIXAS_ANTIGAS[parte.faixa] || `F${parte.faixa}`}{parte.realizacao ? ` (${parte.realizacao})` : ''}</span>;
  }
  return null;
}

export default function CriteriaTable({ log }) {
  const [detalhe, setDetalhe] = useState(null);
  // A equipe recebe a chave do detalhe (evalPartsId); o aluno, só o aviso.
  const temDetalhe = !!(log && log.id && (log.evalPartsId || log.temCriterios));

  useEffect(() => {
    setDetalhe(null);
    if (!temDetalhe) return undefined;
    let vivo = true;
    api.logCriterios(log.id)
      .then((d) => { if (vivo && d && d.disponivel) setDetalhe(d); })
      .catch(() => {}); // sem detalhe, a lista segue só com nome e nota
    return () => { vivo = false; };
  }, [log && log.id, temDetalhe]); // eslint-disable-line react-hooks/exhaustive-deps

  const linhas = linhasDeCriterios(log);
  if (linhas.length === 0) return null;

  const equipe = !!(detalhe && !detalhe.aluno);
  const partes = new Map(((detalhe && detalhe.partes) || []).map((p) => [String(p.num), p]));

  return (
    <div className="criteria-table" style={{ marginBottom: 14 }}>
      <div className="faixas-aluno-titulo">Notas por critério</div>
      <RadarCriterios itens={linhas.map((l) => ({ nome: l.nome, valor: l.nota }))} tamanho={260} />

      {equipe && (
        <div className="criteria-analyses-meta">
          {detalhe.version}
          {detalhe.model ? ` · ${detalhe.model}` : ''}
          {detalhe.effort ? `/${detalhe.effort}` : ''}
          {detalhe.batch ? ' · batch' : ''}
          {detalhe.notaFinal != null ? ` · nota ${detalhe.notaFinal}/100` : ''}
          <em> · comentários visíveis só ao supervisor/admin</em>
        </div>
      )}
      {equipe && detalhe.missao && (
        <div className={`criteria-missao ${detalhe.missao.cumprida ? 'ok' : 'nao'}`}>
          <strong>Missão {detalhe.missao.cumprida ? 'cumprida' : 'não cumprida'}</strong>
          {detalhe.missao.justificativa ? <div>{detalhe.missao.justificativa}</div> : null}
        </div>
      )}

      <div className="crit-lista">
        {linhas.map((l) => {
          const parte = partes.get(l.num);
          const descricao = l.linhaCurta || (parte && parte.linhaCurta) || '';
          return (
            <div key={l.num} className="crit-linha">
              <div className="crit-linha-top">
                <span className="crit-nome">{l.nome}</span>
                <Faixas parte={parte} equipe={equipe} />
                <span className="crit-nota">{l.nota}<span className="crit-nota-max">/10</span></span>
              </div>
              {descricao && <div className="crit-desc">{descricao}</div>}
              {equipe && parte && (
                <>
                  {parte.analise
                    ? <div className="criteria-parte-analise"><RichText text={parte.analise} /></div>
                    : <div className="criteria-parte-analise vazio">(o nó não devolveu análise para este critério)</div>}
                  {parte.qualidadesFaltantes && (
                    <div className="criteria-parte-aviso">
                      O nó não devolveu {parte.qualidadesFaltantes.join(', ')} — sem as cinco não há soma, e o critério ficou fora da nota.
                    </div>
                  )}
                  {parte.travasInconsistentes && (
                    <div className="criteria-parte-aviso">Trava aberta acima de uma fechada — descartada pelo código.</div>
                  )}
                  {!parte.incluido && <div className="criteria-parte-aviso">Fora da nota final (sem nota legível).</div>}
                </>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
