import { useState, useEffect, useRef } from 'react';
import { api } from '../api';
import RichText from './RichText';

// Reavaliação de log e estrelas depois da avaliação (ver o bloco
// "Reavaliação de log" em server/index.js):
//   - supervisor/admin reavaliam direto, ou aprovam/recusam o pedido do aluno;
//   - o aluno acrescenta estrelas ao log avaliado e PEDE a reavaliação;
//   - mudar estrela não reavalia nada sozinho.

// Só a Simulação (Treinamento e Competitivo) é reavaliável, e só depois que a
// avaliação saiu da fila. (O servidor confere de novo.)
export function logReavaliavel(log) {
  return !!log && log.type === 'freeplay' && !log.evaluationPending;
}

export function reavaliacaoAberta(log) {
  const s = log && log.reavaliacao && log.reavaliacao.status;
  return s === 'solicitada' || s === 'em_andamento';
}

function formatar(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  if (isNaN(d)) return '';
  return d.toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

// Enquanto a reavaliação roda, busca o log de novo a cada poucos segundos e
// entrega a versão nova a quem desenha a tela.
export function useLogVivo(log, onAtualizado) {
  const rodando = !!(log && log.reavaliacao && log.reavaliacao.status === 'em_andamento');
  const cb = useRef(onAtualizado);
  cb.current = onAtualizado;
  useEffect(() => {
    if (!rodando || !log) return undefined;
    let vivo = true;
    const t = setInterval(() => {
      api.getLog(log.id)
        .then((novo) => { if (vivo && novo) cb.current && cb.current(novo); })
        .catch(() => {});
    }, 5000);
    return () => { vivo = false; clearInterval(t); };
  }, [rodando, log && log.id]);
}

// Editor das estrelas de um log já salvo. Só as falas do terapeuta têm a
// ferramenta; o texto das falas aparece, mas não é editável.
export function EditorDeEstrelas({ log, onSalvo, onCancelar }) {
  const mensagens = Array.isArray(log.messages) ? log.messages : [];
  const [rascunho, setRascunho] = useState(() => mensagens.map((m) => ({ highlighted: !!m.highlighted, comment: m.comment || '' })));
  const [salvando, setSalvando] = useState(false);
  const [erro, setErro] = useState('');

  function mudar(i, patch) {
    setRascunho((prev) => prev.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  }

  const alteradas = rascunho
    .map((r, i) => ({ ...r, i }))
    .filter(({ highlighted, comment, i }) => {
      const m = mensagens[i];
      if (!m || m.role !== 'user') return false;
      const c = highlighted ? comment.trim() : '';
      return highlighted !== !!m.highlighted || c !== (m.highlighted ? (m.comment || '') : '');
    });

  async function salvar() {
    if (!alteradas.length) { onCancelar(); return; }
    setSalvando(true);
    setErro('');
    try {
      const novo = await api.editarEstrelas(log.id, alteradas.map(({ i, highlighted, comment }) => ({
        posicao: i + 1, highlighted, comment: highlighted ? comment.trim() : '',
      })));
      onSalvo(novo);
    } catch (e) {
      setErro(e.message || 'Não foi possível salvar as estrelas.');
    } finally {
      setSalvando(false);
    }
  }

  return (
    <div>
      <div className="alert" style={{ background: 'var(--sand)', color: 'var(--ink-soft)', marginBottom: 12, fontSize: 13.5 }}>
        Marque com ★ as suas falas em que o raciocínio clínico importa e escreva a justificativa (a hipótese,
        a intenção da intervenção). O texto das falas não muda. Salvar as estrelas <strong>não</strong> refaz
        a avaliação: para isso, peça uma nova avaliação — o supervisor aprova.
      </div>
      {mensagens.map((msg, i) => {
        if (msg.isSystem) return null;
        const isUser = msg.role === 'user';
        const r = rascunho[i] || { highlighted: false, comment: '' };
        return (
          <div key={i} className={`msg ${isUser ? 'user' : 'assistant'}`} style={r.highlighted ? { boxShadow: 'inset 3px 0 0 var(--terra)', paddingLeft: 10 } : undefined}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
              <strong>{isUser ? 'Terapeuta' : 'Paciente'}{r.highlighted ? ' ★' : ''}</strong>
              {isUser && (
                <button
                  type="button"
                  className={`tool-btn ${r.highlighted ? 'active' : ''}`}
                  onClick={() => mudar(i, { highlighted: !r.highlighted })}
                  title={r.highlighted ? 'Remover a estrela' : 'Marcar esta fala com estrela'}
                >
                  ★
                </button>
              )}
            </div>
            <RichText text={msg.content} />
            {isUser && r.highlighted && (
              <textarea
                value={r.comment}
                onChange={(e) => mudar(i, { comment: e.target.value })}
                maxLength={2000}
                placeholder="Por que esta intervenção? (hipótese, intenção, o que você percebeu…)"
                style={{ minHeight: 70, marginTop: 6, fontSize: 13.5 }}
              />
            )}
          </div>
        );
      })}
      {erro && <div className="alert error" style={{ marginTop: 10 }}>{erro}</div>}
      <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 12 }}>
        <button type="button" className="btn btn-outline btn-sm" onClick={onCancelar} disabled={salvando}>Cancelar</button>
        <button type="button" className="btn btn-primary btn-sm" onClick={salvar} disabled={salvando}>
          {salvando ? 'Salvando…' : `Salvar estrelas${alteradas.length ? ` (${alteradas.length})` : ''}`}
        </button>
      </div>
    </div>
  );
}

// Estado da reavaliação + ações. `equipe` = supervisor/admin (Todos os Logs);
// senão é o aluno dono do log (Minhas Sessões).
export function PainelReavaliacao({ log, equipe, onAtualizado, editando, onEditarEstrelas }) {
  const [form, setForm] = useState(null); // 'pedir' | 'reavaliar' | null
  const [motivo, setMotivo] = useState('');
  const [enviando, setEnviando] = useState(false);
  const [erro, setErro] = useState('');
  const [verAnterior, setVerAnterior] = useState(false);

  useLogVivo(log, onAtualizado);

  if (!logReavaliavel(log)) return null;
  const r = log.reavaliacao || null;
  const status = r && r.status;
  const aberta = status === 'solicitada' || status === 'em_andamento';

  // As estrelas mudaram depois da avaliação vigente?
  const baseDaAvaliacao = status === 'concluida' ? r.decididoEm : log.timestamp;
  const estrelasDepois = log.estrelasEditadasEm && baseDaAvaliacao
    && new Date(log.estrelasEditadasEm) > new Date(baseDaAvaliacao);

  async function agir(fn) {
    setEnviando(true);
    setErro('');
    try {
      const novo = await fn();
      if (novo) onAtualizado(novo);
      setForm(null);
      setMotivo('');
    } catch (e) {
      setErro(e.message || 'Não foi possível concluir a ação.');
    } finally {
      setEnviando(false);
    }
  }

  const nota = (n) => (Number.isFinite(n) ? n : '—');
  const erroNaAvaliacao = !!log.evalError && !Number.isFinite(log.score);
  // Durante a edição das estrelas os botões somem; sem nenhum aviso para
  // mostrar, o painel inteiro some junto (não fica um cartão vazio).
  if (editando && !status && !estrelasDepois && !erroNaAvaliacao) return null;

  return (
    <div className="card tight" style={{ marginBottom: 14, padding: '10px 14px', fontSize: 13.5 }}>
      {status === 'solicitada' && (
        <div style={{ marginBottom: 8 }}>
          {equipe ? (
            <>
              <strong>🔁 {r.solicitadoPorNome || 'O aluno'} pediu nova avaliação</strong>
              <span style={{ color: 'var(--muted)' }}> · {formatar(r.solicitadoEm)}</span>
              {r.motivo && <div style={{ marginTop: 4, fontStyle: 'italic' }}>“{r.motivo}”</div>}
            </>
          ) : (
            <>⏳ Pedido de nova avaliação enviado em {formatar(r.solicitadoEm)} — aguardando a aprovação do supervisor.</>
          )}
        </div>
      )}
      {status === 'em_andamento' && (
        <div style={{ marginBottom: 8, display: 'flex', alignItems: 'center', gap: 8 }}>
          <span className="spinner" /> Reavaliando… a nova avaliação aparece aqui em alguns minutos.
        </div>
      )}
      {status === 'concluida' && (
        <div style={{ marginBottom: 8 }}>
          Reavaliada em {formatar(r.concluidoEm)}{r.decididoPorNome ? ` por ${r.decididoPorNome}` : ''}
          {' · '}nota anterior <strong>{nota(r.notaAnterior)}</strong> → <strong>{nota(r.notaNova)}</strong>
          {equipe && r.motivo && <div style={{ marginTop: 4, color: 'var(--muted)' }}>Motivo: {r.motivo}</div>}
          {equipe && r.avaliacaoAnterior && (r.avaliacaoAnterior.evaluation || r.avaliacaoAnterior.evalError) && (
            <div style={{ marginTop: 6 }}>
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => setVerAnterior((v) => !v)}>
                {verAnterior ? 'Ocultar avaliação anterior' : 'Ver avaliação anterior'}
              </button>
              {verAnterior && (
                <div style={{ whiteSpace: 'pre-wrap', marginTop: 8, padding: 10, background: 'var(--sand)', borderRadius: 6 }}>
                  {r.avaliacaoAnterior.evaluation
                    ? <RichText text={r.avaliacaoAnterior.evaluation} />
                    : <em>Sem avaliação — tinha dado erro: {r.avaliacaoAnterior.evalError}</em>}
                </div>
              )}
            </div>
          )}
        </div>
      )}
      {status === 'recusada' && (
        <div style={{ marginBottom: 8, color: 'var(--ink-soft)' }}>
          {equipe
            ? <>Pedido de nova avaliação recusado{r.decididoPorNome ? ` por ${r.decididoPorNome}` : ''} em {formatar(r.decididoEm)}.</>
            : <>Seu pedido de nova avaliação ({formatar(r.solicitadoEm)}) não foi aprovado.</>}
        </div>
      )}
      {status === 'falhou' && (
        <div style={{ marginBottom: 8, color: 'var(--ink-soft)' }}>
          {equipe
            ? <>⚠ A reavaliação de {formatar(r.decididoEm)} falhou: {r.erro || 'erro desconhecido'}. A avaliação anterior continua valendo.</>
            : <>A reavaliação não pôde ser concluída; a avaliação anterior continua valendo.</>}
        </div>
      )}
      {estrelasDepois && !aberta && (
        <div style={{ marginBottom: 8, color: 'var(--ink-soft)' }}>
          ★ Estrelas editadas em {formatar(log.estrelasEditadasEm)}, depois da avaliação atual.
        </div>
      )}
      {erroNaAvaliacao && !aberta && (
        <div style={{ marginBottom: 8, color: 'var(--ink-soft)' }}>⚠ A avaliação desta sessão deu erro{equipe ? `: ${log.evalError}` : ''}.</div>
      )}

      {!editando && status !== 'em_andamento' && (
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
          <button type="button" className="btn btn-outline btn-sm" onClick={onEditarEstrelas} disabled={enviando}>
            ★ Editar estrelas
          </button>
          {equipe ? (
            status === 'solicitada' ? (
              <>
                <button type="button" className="btn btn-primary btn-sm" disabled={enviando}
                  onClick={() => agir(() => api.reavaliar(log.id, ''))}>
                  Aprovar e reavaliar
                </button>
                <button type="button" className="btn btn-ghost btn-sm" disabled={enviando}
                  onClick={() => agir(() => api.recusarReavaliacao(log.id))}>
                  Recusar pedido
                </button>
              </>
            ) : (
              <button type="button" className="btn btn-primary btn-sm" disabled={enviando}
                onClick={() => setForm(form === 'reavaliar' ? null : 'reavaliar')}>
                {status === 'falhou' ? 'Tentar reavaliar de novo' : 'Reavaliar'}
              </button>
            )
          ) : (
            status !== 'solicitada' && (
              <button type="button" className="btn btn-primary btn-sm" disabled={enviando}
                onClick={() => setForm(form === 'pedir' ? null : 'pedir')}>
                Pedir nova avaliação
              </button>
            )
          )}
        </div>
      )}

      {form && (
        <div style={{ marginTop: 10 }}>
          <div style={{ marginBottom: 6, color: 'var(--ink-soft)' }}>
            {form === 'pedir'
              ? 'Conte ao supervisor por que a sessão deve ser reavaliada (ex.: acrescentei estrelas com a justificativa das intervenções).'
              : 'A IA vai avaliar de novo a sessão inteira, com as estrelas que ela tem agora. A avaliação atual fica guardada. Motivo (opcional):'}
          </div>
          <textarea
            value={motivo}
            onChange={(e) => setMotivo(e.target.value)}
            maxLength={1000}
            placeholder={form === 'pedir' ? 'Motivo do pedido (opcional)' : 'Ex.: a nota do critério X não bate com o atendimento'}
            style={{ minHeight: 60, fontSize: 13.5 }}
          />
          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 6 }}>
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => setForm(null)} disabled={enviando}>Cancelar</button>
            <button type="button" className="btn btn-primary btn-sm" disabled={enviando}
              onClick={() => agir(() => (form === 'pedir'
                ? api.solicitarReavaliacao(log.id, motivo)
                : api.reavaliar(log.id, motivo)))}>
              {enviando ? 'Enviando…' : form === 'pedir' ? 'Enviar pedido' : 'Reavaliar agora'}
            </button>
          </div>
        </div>
      )}
      {erro && <div className="alert error" style={{ marginTop: 8 }}>{erro}</div>}
    </div>
  );
}
