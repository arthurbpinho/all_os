// Faixas por critério na visão do ALUNO (decisão do dono, 2026-10-13): o nome e
// a descrição de cada critério e a INICIAL de cada uma das cinco qualidades —
// preenchida de verde (plena), cinza (parcial) ou riscada (ausente). Sem legenda
// e sem a análise em prosa: essa foi escrita com o gabarito à vista e continua
// só do supervisor (CriteriaAnalyses).
//
// O servidor manda só os níveis (detalheParaAluno), e só do próprio atendimento
// — ou do próprio lado, no duelo. O log do aluno traz `temCriterios` em vez da
// chave do arquivo.
import { useEffect, useState } from 'react';
import { api } from '../api';

// A ordem do avaliador: Integridade, Autoria, Potência, Calibração, Excepcionalidade.
const QUALIDADES = [
  ['integridade', 'I'],
  ['autoria', 'A'],
  ['potencia', 'P'],
  ['calibracao', 'C'],
  ['excepcionalidade', 'E'],
];

export default function CriteriaFaixasAluno({ logId, duelId }) {
  const [partes, setPartes] = useState(null);

  useEffect(() => {
    let vivo = true;
    const buscar = duelId ? api.duelCriterios(duelId) : api.logCriterios(logId);
    buscar
      .then((d) => { if (vivo && d && d.disponivel) setPartes(d.partes || []); })
      .catch(() => {}); // sem faixas, a tela fica como antes: nada a mostrar ao aluno
    return () => { vivo = false; };
  }, [logId, duelId]);

  const comFaixas = (partes || []).filter((p) => p.qualidades);
  if (!comFaixas.length) return null;

  return (
    <div className="faixas-aluno">
      <div className="faixas-aluno-titulo">Por critério</div>
      {comFaixas.map((p) => (
        <div key={p.num} className="faixas-aluno-crit">
          <div className="faixas-aluno-top">
            <span className="faixas-aluno-nome">{p.nome}</span>
            <span className="faixas-aluno-iniciais">
              {QUALIDADES.filter(([chave]) => p.qualidades[chave]).map(([chave, inicial]) => (
                <span key={chave} className={`faixa-ini ${p.qualidades[chave]}`}>{inicial}</span>
              ))}
            </span>
          </div>
          {p.linhaCurta && <div className="faixas-aluno-linha">{p.linhaCurta}</div>}
        </div>
      ))}
    </div>
  );
}
