import { ABORDAGENS, rotuloDaAbordagem, alternarAbordagem } from '../abordagens';

// As tags de abordagem do terapeuta, só leitura (logs, lista de alunos).
export function AbordagemTags({ ids, vazio = null, compacto = false }) {
  const lista = (ids || []).map((id) => ({ id, rotulo: rotuloDaAbordagem(id) })).filter((a) => a.rotulo);
  if (!lista.length) return vazio;
  return (
    <span className={`abordagem-tags ${compacto ? 'compacto' : ''}`} title="Abordagem teórica (Perfil)">
      {lista.map((a) => <span key={a.id} className="abordagem-tag">{a.rotulo}</span>)}
    </span>
  );
}

// Seletor do Perfil: todas as tags; a inativa aparece desabilitada.
export function SeletorDeAbordagens({ valor, onChange, disabled = false }) {
  return (
    <div className="abordagem-tags seletor" role="group" aria-label="Abordagem teórica">
      {ABORDAGENS.map((a) => {
        const ativa = valor.includes(a.id);
        return (
          <button
            key={a.id}
            type="button"
            className={`abordagem-tag ${ativa ? 'selecionada' : ''}`}
            aria-pressed={ativa}
            disabled={disabled || !a.ativa}
            title={a.ativa ? undefined : 'Ainda não disponível'}
            onClick={() => onChange(alternarAbordagem(valor, a.id))}
          >
            {a.rotulo}{!a.ativa && <span className="abordagem-tag-em-breve"> · em breve</span>}
          </button>
        );
      })}
    </div>
  );
}
