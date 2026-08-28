import { useState, useEffect, useCallback } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api';
import Typewriter from '../components/Typewriter';
import RichText from '../components/RichText';
import CommunityAuthor from '../components/CommunityAuthor';
import VoteButtons from '../components/VoteButtons';
import { fotoDoUsuario } from '../utils/avatar';

// Comunidade: o feed de discussões.
//
// Uma "discussão" é o que outros fóruns chamam de thread — título, texto (ou
// enquete), votos e comentários. Cada uma tem link próprio
// (/comunidade/discussao/:id) que abre para qualquer pessoa, com ou sem conta;
// esta tela, por ser a porta de entrada dentro do app, exige sessão.
//
// Quem não pode escrever (visitante, ou alguém suspenso pela moderação) vê o
// feed inteiro com o compositor trocado por um aviso — esconder a tela seria
// pior: a leitura é justamente o que convence a criar conta.

const TITULO_MAX = 200;
const CORPO_MAX = 10000;
const OPCAO_MAX = 120;
const MAX_OPCOES = 10;

export default function Comunidade({ user }) {
  const [dados, setDados] = useState(null);
  const [carregando, setCarregando] = useState(true);
  const [erro, setErro] = useState('');
  const [ordem, setOrdem] = useState('recent');
  const [compondo, setCompondo] = useState(false);

  const carregar = useCallback((sort) => {
    return api.getComunidade(sort)
      .then(setDados)
      .catch((e) => setErro(e.message || 'Não foi possível carregar a Comunidade.'));
  }, []);

  useEffect(() => {
    setCarregando(true);
    carregar(ordem).finally(() => setCarregando(false));
  }, [carregar, ordem]);

  function aoCriar(nova) {
    setCompondo(false);
    // Insere no topo em vez de recarregar: quem acabou de publicar quer ver o
    // próprio post, e não perder a rolagem do feed.
    setDados((d) => (d ? { ...d, discussions: [nova, ...d.discussions] } : d));
  }

  if (carregando) {
    return (
      <div className="card" style={{ textAlign: 'center', padding: 40 }}>
        <span className="spinner" /> <span style={{ marginLeft: 12 }}>Carregando a Comunidade…</span>
      </div>
    );
  }
  if (erro) return <div className="alert error">{erro}</div>;
  if (!dados) return null;

  return (
    <div className="comunidade">
      <div className="page-header">
        <div className="eyebrow">Espaço de troca</div>
        <h2>
          <Typewriter text="Comu" />
          <span className="accent"><Typewriter text="nidade" delayStart={260} /></span>
        </h2>
        <p>Discussões clínicas, dúvidas, enquetes e os comunicados da Associação Allos.</p>
        <div className="ornament" />
      </div>

      {dados.canPost ? (
        compondo ? (
          <NovaDiscussao user={user} onCriada={aoCriar} onCancelar={() => setCompondo(false)} />
        ) : (
          <button type="button" className="comunidade-compositor-atalho" onClick={() => setCompondo(true)}>
            <span className="comunidade-compositor-avatar">
              {fotoDoUsuario(user)
                ? <img src={fotoDoUsuario(user)} alt="" />
                : <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6"><circle cx="12" cy="8" r="4" /><path d="M4 21v-1a6 6 0 0 1 6-6h4a6 6 0 0 1 6 6v1" /></svg>}
            </span>
            <span className="comunidade-compositor-texto">Comece uma discussão…</span>
            <span className="btn btn-primary btn-sm" aria-hidden="true">Nova discussão</span>
          </button>
        )
      ) : (
        <div className="comunidade-aviso-leitura">
          <strong>{dados.blockedReason}</strong>
          {/* Visitante tem caminho de saída; suspenso, não — daí a checagem. */}
          {user?.role === 'visitor' && (
            <span> <Link to="/cadastro">Crie uma conta</Link> para contribuir com suas ideias.</span>
          )}
        </div>
      )}

      <div className="comunidade-ordem" role="tablist" aria-label="Ordenar discussões">
        <button
          type="button" role="tab" aria-selected={ordem === 'recent'}
          className={ordem === 'recent' ? 'ativo' : ''}
          onClick={() => setOrdem('recent')}
        >Recentes</button>
        <button
          type="button" role="tab" aria-selected={ordem === 'top'}
          className={ordem === 'top' ? 'ativo' : ''}
          onClick={() => setOrdem('top')}
        >Em alta</button>
      </div>

      {dados.discussions.length === 0 ? (
        <div className="card comunidade-vazio">
          <p>Ainda não há discussões por aqui.</p>
          {dados.canPost && <p className="dica">Seja quem abre a primeira — uma dúvida de caso costuma render bastante.</p>}
        </div>
      ) : (
        <div className="comunidade-feed">
          {dados.discussions.map((d) => (
            <CardDiscussao key={d.id} d={d} podeVotar={dados.canPost} />
          ))}
        </div>
      )}
    </div>
  );
}

function CardDiscussao({ d, podeVotar }) {
  return (
    <article className={`comunidade-card kind-${d.author.kind}`}>
      <VoteButtons
        score={d.score}
        myVote={d.myVote}
        disabled={!podeVotar}
        onVote={(v) => api.voteDiscussion(d.id, v)}
      />
      <div className="comunidade-card-corpo">
        <CommunityAuthor author={d.author} createdAt={d.createdAt} compact />
        <h3 className="comunidade-card-titulo">
          <Link to={`/comunidade/discussao/${d.id}`}>{d.title}</Link>
        </h3>
        {d.excerpt && (
          <p className="comunidade-card-resumo">
            <RichText text={d.excerpt} />
            {d.truncated && <Link className="comunidade-continuar" to={`/comunidade/discussao/${d.id}`}>… continuar lendo</Link>}
          </p>
        )}
        <div className="comunidade-card-rodape">
          {d.hasPoll && <span className="comunidade-tag-enquete">Enquete</span>}
          <Link className="comunidade-link-comentarios" to={`/comunidade/discussao/${d.id}`}>
            {d.commentCount === 0 ? 'Comentar' : `${d.commentCount} ${d.commentCount === 1 ? 'comentário' : 'comentários'}`}
          </Link>
        </div>
      </div>
    </article>
  );
}

// Compositor. A enquete é opcional e some inteira quando desligada — o campo
// de texto continua sendo o caminho principal.
function NovaDiscussao({ user, onCriada, onCancelar }) {
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [comEnquete, setComEnquete] = useState(false);
  const [opcoes, setOpcoes] = useState(['', '']);
  const [multi, setMulti] = useState(false);
  const [comoAllos, setComoAllos] = useState(user?.role === 'admin');
  const [enviando, setEnviando] = useState(false);
  const [erro, setErro] = useState('');

  function mudarOpcao(i, v) {
    setOpcoes((o) => o.map((x, j) => (j === i ? v.slice(0, OPCAO_MAX) : x)));
  }

  async function enviar(e) {
    e.preventDefault();
    setErro('');
    setEnviando(true);
    try {
      const nova = await api.createDiscussion({
        title,
        body,
        asInstitution: user?.role === 'admin' ? comoAllos : undefined,
        poll: comEnquete ? { options: opcoes, multi } : undefined,
      });
      onCriada(nova);
    } catch (err) {
      setErro(err.message || 'Não foi possível publicar.');
    } finally {
      setEnviando(false);
    }
  }

  return (
    <form className="card comunidade-compositor" onSubmit={enviar}>
      <h3>Nova discussão</h3>

      {user?.role === 'admin' && (
        <div className="form-group">
          <label>Publicar como</label>
          <div className="comunidade-como-publicar">
            <button
              type="button"
              className={comoAllos ? 'ativo' : ''}
              onClick={() => setComoAllos(true)}
            >Associação Allos</button>
            <button
              type="button"
              className={!comoAllos ? 'ativo' : ''}
              onClick={() => setComoAllos(false)}
            >{user.name}</button>
          </div>
        </div>
      )}

      <div className="form-group">
        <label htmlFor="disc-titulo">Título</label>
        <input
          id="disc-titulo"
          value={title}
          onChange={(e) => setTitle(e.target.value.slice(0, TITULO_MAX))}
          placeholder="Sobre o que você quer conversar?"
          maxLength={TITULO_MAX}
          autoFocus
        />
        <div className="contador">{title.length}/{TITULO_MAX}</div>
      </div>

      <div className="form-group">
        <label htmlFor="disc-corpo">Texto {comEnquete && <span className="opcional">(opcional com enquete)</span>}</label>
        <textarea
          id="disc-corpo"
          rows={6}
          value={body}
          onChange={(e) => setBody(e.target.value.slice(0, CORPO_MAX))}
          placeholder="Escreva aqui. *itálico* e **negrito** funcionam."
          maxLength={CORPO_MAX}
        />
        <div className="contador">{body.length}/{CORPO_MAX}</div>
      </div>

      <div className="form-group">
        <label className="comunidade-check">
          <input type="checkbox" checked={comEnquete} onChange={(e) => setComEnquete(e.target.checked)} />
          <span>Adicionar uma enquete</span>
        </label>
      </div>

      {comEnquete && (
        <div className="comunidade-editor-enquete">
          {/* O tipo vale para todo mundo que responder e não muda depois de
              publicado, então fica aqui em cima, antes das opções. */}
          <div className="comunidade-enquete-tipo">
            <button
              type="button"
              className={!multi ? 'ativo' : ''}
              onClick={() => setMulti(false)}
              aria-pressed={!multi}
            >Opção única</button>
            <button
              type="button"
              className={multi ? 'ativo' : ''}
              onClick={() => setMulti(true)}
              aria-pressed={multi}
            >Múltipla escolha</button>
          </div>
          <p className="comunidade-enquete-tipo-dica">
            {multi
              ? 'Quem responder pode marcar mais de uma opção.'
              : 'Quem responder escolhe uma opção só.'}
          </p>
          {opcoes.map((o, i) => (
            <div key={i} className="comunidade-opcao-linha">
              <input
                value={o}
                onChange={(e) => mudarOpcao(i, e.target.value)}
                placeholder={`Opção ${i + 1}`}
                maxLength={OPCAO_MAX}
              />
              {/* Duas opções são o mínimo de uma enquete: abaixo disso não há
                  escolha, então o botão de remover some. */}
              {opcoes.length > 2 && (
                <button
                  type="button"
                  className="btn btn-ghost btn-sm"
                  onClick={() => setOpcoes((x) => x.filter((_, j) => j !== i))}
                  aria-label={`Remover opção ${i + 1}`}
                >×</button>
              )}
            </div>
          ))}
          {opcoes.length < MAX_OPCOES && (
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => setOpcoes((x) => [...x, ''])}>
              + Adicionar opção
            </button>
          )}
        </div>
      )}

      {erro && <div className="alert error">{erro}</div>}

      <div className="modal-actions">
        <button type="button" className="btn btn-ghost" onClick={onCancelar} disabled={enviando}>Cancelar</button>
        <button type="submit" className="btn btn-primary" disabled={enviando || title.trim().length < 3}>
          {enviando ? 'Publicando…' : 'Publicar'}
        </button>
      </div>
    </form>
  );
}
