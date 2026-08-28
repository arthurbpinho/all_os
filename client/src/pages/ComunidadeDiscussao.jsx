import { useState, useEffect, useCallback, useRef } from 'react';
import { useParams, Link, useNavigate } from 'react-router-dom';
import { api } from '../api';
import RichText from '../components/RichText';
import CommunityAuthor from '../components/CommunityAuthor';
import VoteButtons from '../components/VoteButtons';

// Uma discussão inteira: texto (ou enquete), votos e a árvore de comentários.
//
// Esta é a única tela do app que roda com ou SEM sessão. O link
// /comunidade/discussao/:id é o que o botão compartilhar copia, então precisa
// abrir para quem recebeu a mensagem sem ter conta — em modo leitura, com um
// banner convidando ao cadastro. Por isso ela vive fora do shell do app quando
// não há usuário (ver App.jsx) e nunca assume que `user` existe.
//
// O componente recarrega a discussão inteira depois de comentar em vez de
// remendar o estado: comentário mexe em ordenação (as raízes ordenam por voto)
// e em contagem, e reconstruir isso no cliente duplicaria a regra do servidor.

export default function ComunidadeDiscussao({ user }) {
  const { id } = useParams();
  const navigate = useNavigate();
  const [dados, setDados] = useState(null);
  const [carregando, setCarregando] = useState(true);
  const [erro, setErro] = useState('');
  const [copiado, setCopiado] = useState(false);

  const carregar = useCallback(() => {
    return api.getDiscussion(id)
      .then((d) => { setDados(d); setErro(''); })
      .catch((e) => setErro(e.message || 'Não foi possível abrir a discussão.'));
  }, [id]);

  useEffect(() => {
    setCarregando(true);
    setDados(null);
    carregar().finally(() => setCarregando(false));
  }, [carregar]);

  async function compartilhar() {
    const url = `${window.location.origin}/comunidade/discussao/${id}`;
    // O compartilhamento nativo é o caminho bom no celular (manda direto pro
    // WhatsApp). No desktop ele não existe, e aí copiar o link é o equivalente.
    try {
      if (navigator.share) {
        await navigator.share({ title: dados?.discussion?.title || 'Discussão', url });
        return;
      }
    } catch { /* cancelou o menu nativo: cai na cópia */ }
    try {
      await navigator.clipboard.writeText(url);
      setCopiado(true);
      setTimeout(() => setCopiado(false), 2000);
    } catch {
      // clipboard bloqueado (http, permissão negada): mostra o link pra pessoa
      // copiar na mão em vez de fingir que copiou.
      window.prompt('Copie o link da discussão:', url);
    }
  }

  async function excluirDiscussao() {
    if (!window.confirm('Excluir esta discussão? Os comentários também somem.')) return;
    try {
      await api.deleteDiscussion(id);
      navigate('/comunidade');
    } catch (e) {
      setErro(e.message || 'Não foi possível excluir.');
    }
  }

  if (carregando) {
    return (
      <div className="card" style={{ textAlign: 'center', padding: 40 }}>
        <span className="spinner" /> <span style={{ marginLeft: 12 }}>Carregando discussão…</span>
      </div>
    );
  }
  if (erro && !dados) {
    return (
      <div className="comunidade">
        <div className="alert error">{erro}</div>
        <Link className="btn btn-ghost" to="/comunidade">Voltar para a Comunidade</Link>
      </div>
    );
  }
  if (!dados) return null;

  const { discussion: d, canPost, blockedReason, anonymous, canModerate } = dados;
  const souAutor = !!(user && d.author.userId && d.author.userId === user.id);

  return (
    <div className="comunidade comunidade-discussao">
      {/* Banner de quem chegou pelo link sem conta. É o convite ao cadastro
          combinado com o botão compartilhar — sem ele, o link compartilhado
          seria um beco sem saída. */}
      {anonymous && (
        <div className="comunidade-banner-visitante">
          Essa discussão é apenas para visualização,{' '}
          <Link to="/cadastro">crie uma conta</Link> para poder contribuir com suas ideias!
        </div>
      )}

      {!anonymous && (
        <Link className="comunidade-voltar" to="/comunidade">← Comunidade</Link>
      )}

      <article className={`comunidade-thread kind-${d.author.kind}`}>
        <header className="comunidade-thread-topo">
          <CommunityAuthor author={d.author} createdAt={d.createdAt} />
          <div className="comunidade-thread-acoes">
            <button type="button" className="btn btn-ghost btn-sm" onClick={compartilhar}>
              {copiado ? 'Link copiado!' : 'Compartilhar'}
            </button>
            {(souAutor || canModerate) && (
              <button type="button" className="btn btn-ghost btn-sm perigo" onClick={excluirDiscussao}>
                Excluir
              </button>
            )}
          </div>
        </header>

        <h2 className="comunidade-thread-titulo">{d.title}</h2>
        {d.body && (
          <div className="comunidade-thread-texto"><RichText text={d.body} /></div>
        )}

        {d.poll && <Enquete id={d.id} poll={d.poll} podeVotar={canPost} onVotou={carregar} />}

        <footer className="comunidade-thread-rodape">
          <VoteButtons
            score={d.score}
            myVote={d.myVote}
            disabled={!canPost}
            orientation="horizontal"
            onVote={(v) => api.voteDiscussion(d.id, v)}
          />
          <span className="comunidade-contagem">
            {d.comments.length === 0 ? 'Nenhum comentário ainda' : `${contarTodos(d.comments)} ${contarTodos(d.comments) === 1 ? 'comentário' : 'comentários'}`}
          </span>
        </footer>
      </article>

      {canPost ? (
        <CaixaComentario
          discussionId={d.id}
          user={user}
          onEnviado={carregar}
          placeholder="Contribua com a discussão…"
        />
      ) : !anonymous && (
        <div className="comunidade-aviso-leitura">{blockedReason}</div>
      )}

      <div className="comunidade-comentarios">
        {d.comments.map((c) => (
          <Comentario
            key={c.id}
            c={c}
            discussionId={d.id}
            user={user}
            canPost={canPost}
            canModerate={canModerate}
            onMudou={carregar}
          />
        ))}
      </div>
    </div>
  );
}

function contarTodos(comments) {
  return comments.reduce((n, c) => n + (c.deleted ? 0 : 1) + c.replies.length, 0);
}

// Enquete: resultado revelado depois do voto (o servidor decide isso e manda
// `revealed`). Quem criou escolheu entre opção única — clicar em outra troca o
// voto — e múltipla escolha, onde cada clique marca/desmarca uma opção. Nos dois
// casos o cliente manda só o id clicado; o servidor sabe o que fazer com ele.
function Enquete({ id, poll, podeVotar, onVotou }) {
  const [enviando, setEnviando] = useState(null);
  const [estado, setEstado] = useState(poll);
  const [erro, setErro] = useState('');

  // A discussão pode ser recarregada por fora (um comentário novo, por
  // exemplo); sem isto a enquete ficaria congelada no estado do primeiro render.
  useEffect(() => { setEstado(poll); }, [poll]);

  async function votar(optionId) {
    if (!podeVotar || enviando) return;
    setErro('');
    setEnviando(optionId);
    try {
      const r = await api.votePoll(id, optionId);
      setEstado(r.poll);
      if (onVotou) onVotou();
    } catch (e) {
      setErro(e.message || 'Não foi possível registrar seu voto.');
    } finally {
      setEnviando(null);
    }
  }

  return (
    <div className="comunidade-enquete">
      {estado.options.map((o) => {
        const escolhida = (estado.myVotes || []).includes(o.id);
        return (
          <button
            key={o.id}
            type="button"
            className={`comunidade-enquete-opcao ${escolhida ? 'escolhida' : ''} ${estado.revealed ? 'revelada' : ''} ${estado.multi ? 'multi' : ''}`}
            onClick={() => votar(o.id)}
            disabled={!podeVotar || !!enviando}
            aria-pressed={escolhida}
          >
            {/* Na múltipla escolha a marca é o que avisa, antes de qualquer
                clique, que dá pra marcar mais de uma. */}
            {estado.multi && (
              <span className="comunidade-enquete-marca" aria-hidden="true">{escolhida ? '✓' : ''}</span>
            )}
            {/* A barra é o próprio fundo da opção, então o percentual não
                precisa de um gráfico ao lado ocupando largura no celular. */}
            {estado.revealed && (
              <span className="comunidade-enquete-barra" style={{ width: `${o.percent}%` }} aria-hidden="true" />
            )}
            <span className="comunidade-enquete-texto">{o.text}</span>
            {estado.revealed && <span className="comunidade-enquete-pct">{o.percent}%</span>}
          </button>
        );
      })}
      <div className="comunidade-enquete-rodape">
        {estado.total} {estado.total === 1 ? 'voto' : 'votos'}
        {estado.multi && ' · múltipla escolha'}
        {!estado.revealed && podeVotar && ' · vote para ver o resultado'}
      </div>
      {erro && <div className="alert error">{erro}</div>}
    </div>
  );
}

function CaixaComentario({ discussionId, user, parentId, onEnviado, onCancelar, placeholder, autoFocus }) {
  const [texto, setTexto] = useState('');
  const [comoAllos, setComoAllos] = useState(false);
  const [enviando, setEnviando] = useState(false);
  const [erro, setErro] = useState('');
  const ref = useRef(null);

  useEffect(() => { if (autoFocus && ref.current) ref.current.focus(); }, [autoFocus]);

  async function enviar(e) {
    e.preventDefault();
    if (!texto.trim()) return;
    setErro('');
    setEnviando(true);
    try {
      await api.createComment(discussionId, {
        body: texto,
        parentId,
        asInstitution: user?.role === 'admin' ? comoAllos : undefined,
      });
      setTexto('');
      await onEnviado();
      if (onCancelar) onCancelar();
    } catch (err) {
      setErro(err.message || 'Não foi possível comentar.');
    } finally {
      setEnviando(false);
    }
  }

  return (
    <form className={`comunidade-caixa ${parentId ? 'resposta' : ''}`} onSubmit={enviar}>
      <textarea
        ref={ref}
        rows={parentId ? 2 : 3}
        value={texto}
        onChange={(e) => setTexto(e.target.value.slice(0, 5000))}
        placeholder={placeholder || 'Responder…'}
      />
      {erro && <div className="alert error">{erro}</div>}
      <div className="comunidade-caixa-acoes">
        {user?.role === 'admin' && (
          <label className="comunidade-check">
            <input type="checkbox" checked={comoAllos} onChange={(e) => setComoAllos(e.target.checked)} />
            <span>Como Associação Allos</span>
          </label>
        )}
        {onCancelar && (
          <button type="button" className="btn btn-ghost btn-sm" onClick={onCancelar} disabled={enviando}>Cancelar</button>
        )}
        <button type="submit" className="btn btn-primary btn-sm" disabled={enviando || !texto.trim()}>
          {enviando ? 'Enviando…' : 'Comentar'}
        </button>
      </div>
    </form>
  );
}

function Comentario({ c, discussionId, user, canPost, canModerate, onMudou, aninhado = false }) {
  const [respondendo, setRespondendo] = useState(false);
  const souAutor = !!(user && c.author && c.author.userId && c.author.userId === user.id);

  async function excluir() {
    if (!window.confirm('Excluir este comentário?')) return;
    try {
      await api.deleteComment(discussionId, c.id);
      await onMudou();
    } catch { /* a recarga já mostraria o estado real; um alerta aqui só atrapalha */ }
  }

  return (
    <div className={`comunidade-comentario ${aninhado ? 'aninhado' : ''} ${c.deleted ? 'removido' : ''} ${c.author ? `kind-${c.author.kind}` : ''}`}>
      <div className="comunidade-comentario-linha">
        <VoteButtons
          score={c.score}
          myVote={c.myVote}
          disabled={!canPost || c.deleted}
          onVote={(v) => api.voteComment(discussionId, c.id, v)}
        />
        <div className="comunidade-comentario-corpo">
          {c.deleted ? (
            <p className="comunidade-comentario-removido">Comentário removido.</p>
          ) : (
            <>
              <CommunityAuthor author={c.author} createdAt={c.createdAt} compact />
              <div className="comunidade-comentario-texto"><RichText text={c.body} /></div>
              <div className="comunidade-comentario-acoes">
                {/* Só a raiz oferece "Responder": a árvore tem um nível só, e
                    oferecer o botão na resposta prometeria uma profundidade
                    que o servidor reancora de volta. */}
                {canPost && !aninhado && (
                  <button type="button" onClick={() => setRespondendo((v) => !v)}>
                    {respondendo ? 'Cancelar' : 'Responder'}
                  </button>
                )}
                {(souAutor || canModerate) && (
                  <button type="button" className="perigo" onClick={excluir}>Excluir</button>
                )}
              </div>
            </>
          )}

          {respondendo && (
            <CaixaComentario
              discussionId={discussionId}
              user={user}
              parentId={c.id}
              autoFocus
              onEnviado={onMudou}
              onCancelar={() => setRespondendo(false)}
            />
          )}
        </div>
      </div>

      {(c.replies || []).map((r) => (
        <Comentario
          key={r.id}
          c={r}
          discussionId={discussionId}
          user={user}
          canPost={canPost}
          canModerate={canModerate}
          onMudou={onMudou}
          aninhado
        />
      ))}
    </div>
  );
}
