import { useState, useEffect, useCallback } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api';
import Typewriter from '../components/Typewriter';
import PhotoCropper from '../components/PhotoCropper';
import { tempoRelativo } from '../components/CommunityAuthor';

// Administração da Comunidade — só o admin chega aqui (o servidor também
// recusa os outros papéis, ver requireRole('admin') nas rotas).
//
// Duas frentes:
//   Moderação — banir por N dias, apagar tudo ou só publicações escolhidas de
//     alguém. Excluir uma discussão ou comentário avulso NÃO mora aqui: o admin
//     faz isso no próprio post, onde o contexto está.
//   Identidade — a imagem da Associação Allos (usada nas publicações
//     institucionais) e a pool de até 10 avatares de visitante.

export default function AdminComunidade() {
  const [dados, setDados] = useState(null);
  const [carregando, setCarregando] = useState(true);
  const [erro, setErro] = useState('');
  const [aba, setAba] = useState('moderacao');

  const carregar = useCallback(() => {
    return api.adminGetComunidade()
      .then((d) => { setDados(d); setErro(''); })
      .catch((e) => setErro(e.message || 'Não foi possível carregar o painel.'));
  }, []);

  useEffect(() => {
    setCarregando(true);
    carregar().finally(() => setCarregando(false));
  }, [carregar]);

  if (carregando) {
    return (
      <div className="card" style={{ textAlign: 'center', padding: 40 }}>
        <span className="spinner" /> <span style={{ marginLeft: 12 }}>Carregando…</span>
      </div>
    );
  }
  if (erro && !dados) return <div className="alert error">{erro}</div>;
  if (!dados) return null;

  return (
    <div className="comunidade-admin">
      <div className="page-header">
        <div className="eyebrow">Administração</div>
        <h2>
          <Typewriter text="Comunidade" />
        </h2>
        <p>Moderação de membros e identidade visual do espaço.</p>
        <div className="ornament" />
      </div>

      <div className="tabs">
        <button className={aba === 'moderacao' ? 'active' : ''} onClick={() => setAba('moderacao')}>Moderação</button>
        <button className={aba === 'identidade' ? 'active' : ''} onClick={() => setAba('identidade')}>Identidade</button>
      </div>

      {erro && <div className="alert error">{erro}</div>}

      {aba === 'moderacao'
        ? <Moderacao dados={dados} onMudou={carregar} />
        : <Identidade dados={dados} onMudou={carregar} />}
    </div>
  );
}

function Moderacao({ dados, onMudou }) {
  const [alvo, setAlvo] = useState(null); // usuário aberto no painel lateral

  return (
    <>
      {dados.bans.length > 0 && (
        <div className="card">
          <h3>Suspensões vigentes</h3>
          <table className="admin-table">
            <thead>
              <tr><th>Membro</th><th>Até</th><th>Motivo</th><th /></tr>
            </thead>
            <tbody>
              {dados.bans.map((b) => (
                <tr key={b.userId}>
                  <td>{b.name}</td>
                  <td>{new Date(b.until).toLocaleDateString('pt-BR')}</td>
                  <td>{b.reason || <span className="comunidade-muted">—</span>}</td>
                  <td style={{ textAlign: 'right' }}>
                    <button
                      className="btn btn-ghost btn-sm"
                      onClick={() => api.adminUnbanComunidade(b.userId).then(onMudou)}
                    >Revogar</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="card">
        <h3>Quem publica na Comunidade</h3>
        {dados.autores.length === 0 ? (
          <p className="comunidade-muted">Ninguém publicou nada ainda.</p>
        ) : (
          <table className="admin-table">
            <thead>
              <tr><th>Membro</th><th>Discussões</th><th>Comentários</th><th>Situação</th><th /></tr>
            </thead>
            <tbody>
              {dados.autores.map((a) => (
                <tr key={a.id}>
                  <td>
                    {a.name}
                    {a.username && <span className="comunidade-muted"> @{a.username}</span>}
                  </td>
                  <td>{a.discussions}</td>
                  <td>{a.comments}</td>
                  <td>
                    {a.ban
                      ? <span className="comunidade-pill perigo">Suspenso até {new Date(a.ban.until).toLocaleDateString('pt-BR')}</span>
                      : <span className="comunidade-muted">Ativo</span>}
                  </td>
                  <td style={{ textAlign: 'right' }}>
                    <button className="btn btn-ghost btn-sm" onClick={() => setAlvo(a)}>Gerenciar</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {alvo && (
        <PainelMembro
          autor={alvo}
          onFechar={() => setAlvo(null)}
          onMudou={() => { onMudou(); setAlvo(null); }}
        />
      )}
    </>
  );
}

// Modal de um membro: banir por N dias (com ou sem limpeza) e apagar
// publicações escolhidas a dedo.
function PainelMembro({ autor, onFechar, onMudou }) {
  const [conteudo, setConteudo] = useState(null);
  const [dias, setDias] = useState(7);
  const [motivo, setMotivo] = useState('');
  const [limparTudo, setLimparTudo] = useState(false);
  const [selecionadas, setSelecionadas] = useState(() => new Set());
  const [ocupado, setOcupado] = useState(false);
  const [erro, setErro] = useState('');

  useEffect(() => {
    api.adminGetComunidadeUser(autor.id)
      .then(setConteudo)
      .catch((e) => setErro(e.message || 'Não foi possível carregar as publicações.'));
  }, [autor.id]);

  function alternar(id) {
    setSelecionadas((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id); else n.add(id);
      return n;
    });
  }

  async function banir() {
    setErro('');
    setOcupado(true);
    try {
      await api.adminBanComunidade({ userId: autor.id, days: Number(dias), reason: motivo, purge: limparTudo });
      onMudou();
    } catch (e) {
      setErro(e.message || 'Não foi possível suspender.');
      setOcupado(false);
    }
  }

  async function apagarSelecionadas() {
    if (!selecionadas.size) return;
    if (!window.confirm(`Apagar ${selecionadas.size} discussão(ões) de ${autor.name}?`)) return;
    setErro('');
    setOcupado(true);
    try {
      await api.adminPurgeComunidade({ userId: autor.id, discussionIds: [...selecionadas] });
      onMudou();
    } catch (e) {
      setErro(e.message || 'Não foi possível apagar.');
      setOcupado(false);
    }
  }

  return (
    <div className="modal-overlay" onClick={(e) => { if (e.target === e.currentTarget) onFechar(); }}>
      <div className="modal" style={{ maxWidth: 640 }}>
        <h3>{autor.name}</h3>
        {erro && <div className="alert error">{erro}</div>}

        <section className="comunidade-admin-bloco">
          <h4>Suspender participação</h4>
          <p className="comunidade-muted">
            A pessoa continua lendo a Comunidade, mas não publica, comenta nem vota até a data.
          </p>
          <div className="comunidade-admin-ban">
            <label>
              <span>Dias</span>
              <input type="number" min="1" max="3650" value={dias} onChange={(e) => setDias(e.target.value)} />
            </label>
            <label style={{ flex: 1 }}>
              <span>Motivo (opcional, aparece para a pessoa)</span>
              <input value={motivo} onChange={(e) => setMotivo(e.target.value.slice(0, 300))} placeholder="ex.: publicidade repetida" />
            </label>
          </div>
          <label className="comunidade-check">
            <input type="checkbox" checked={limparTudo} onChange={(e) => setLimparTudo(e.target.checked)} />
            <span>Apagar também tudo que essa pessoa publicou</span>
          </label>
          <button className="btn btn-danger" onClick={banir} disabled={ocupado}>
            {ocupado ? 'Aplicando…' : `Suspender por ${dias} dia(s)`}
          </button>
        </section>

        <section className="comunidade-admin-bloco">
          <h4>Publicações</h4>
          {!conteudo ? (
            <p className="comunidade-muted"><span className="spinner" /> Carregando…</p>
          ) : (
            <>
              {conteudo.discussions.length === 0 ? (
                <p className="comunidade-muted">Nenhuma discussão.</p>
              ) : (
                <ul className="comunidade-admin-lista">
                  {conteudo.discussions.map((d) => (
                    <li key={d.id}>
                      <label className="comunidade-check">
                        <input type="checkbox" checked={selecionadas.has(d.id)} onChange={() => alternar(d.id)} />
                        <span>
                          <Link to={`/comunidade/discussao/${d.id}`} target="_blank" rel="noreferrer">{d.title}</Link>
                          <span className="comunidade-muted"> · {tempoRelativo(d.createdAt)} · {d.commentCount} comentário(s)</span>
                        </span>
                      </label>
                    </li>
                  ))}
                </ul>
              )}
              {conteudo.discussions.length > 0 && (
                <button className="btn btn-ghost btn-sm" onClick={apagarSelecionadas} disabled={ocupado || !selecionadas.size}>
                  Apagar selecionadas ({selecionadas.size})
                </button>
              )}

              {conteudo.comments.length > 0 && (
                <>
                  <h5 style={{ marginTop: 16 }}>Comentários ({conteudo.comments.length})</h5>
                  <ul className="comunidade-admin-lista comentarios">
                    {conteudo.comments.slice(0, 20).map((c) => (
                      <li key={c.id}>
                        <Link to={`/comunidade/discussao/${c.discussionId}`} target="_blank" rel="noreferrer">
                          {c.discussionTitle}
                        </Link>
                        <div className="comunidade-muted">{c.body}</div>
                      </li>
                    ))}
                  </ul>
                  <p className="comunidade-muted">
                    Comentário avulso se apaga no próprio post. Para tirar todos de uma vez,
                    marque “apagar também tudo que essa pessoa publicou” ao suspender.
                  </p>
                </>
              )}
            </>
          )}
        </section>

        <div className="modal-actions">
          <button className="btn btn-ghost" onClick={onFechar}>Fechar</button>
        </div>
      </div>
    </div>
  );
}

function Identidade({ dados, onMudou }) {
  const [recortando, setRecortando] = useState(null); // 'instituicao' | 'visitante'
  const [erro, setErro] = useState('');
  const [ocupado, setOcupado] = useState(false);

  async function salvarRecorte(dataUrl) {
    const destino = recortando;
    setRecortando(null);
    setErro('');
    setOcupado(true);
    try {
      if (destino === 'instituicao') await api.adminSetInstitutionAvatar({ image: dataUrl });
      else await api.adminAddVisitorAvatar(dataUrl);
      await onMudou();
    } catch (e) {
      setErro(e.message || 'Não foi possível salvar a imagem.');
    } finally {
      setOcupado(false);
    }
  }

  return (
    <>
      <div className="card">
        <h3>Imagem da Associação Allos</h3>
        <p className="comunidade-muted">
          Aparece nas discussões e comentários publicados como Associação Allos. Sem imagem,
          a marca do app é usada no lugar.
        </p>
        <div className="comunidade-admin-avatar">
          <span className="comunidade-avatar kind-allos grande">
            {dados.institutionAvatar
              ? <img src={dados.institutionAvatar} alt="" />
              : <span className="comunidade-logo-allos">a<span>_</span></span>}
          </span>
          <div className="comunidade-admin-avatar-acoes">
            <button className="btn btn-primary btn-sm" onClick={() => setRecortando('instituicao')} disabled={ocupado}>
              {dados.institutionAvatar ? 'Trocar imagem' : 'Enviar imagem'}
            </button>
            {dados.institutionAvatar && (
              <button
                className="btn btn-ghost btn-sm"
                disabled={ocupado}
                onClick={() => api.adminSetInstitutionAvatar({ clear: true }).then(onMudou).catch((e) => setErro(e.message))}
              >Remover</button>
            )}
          </div>
        </div>
      </div>

      <div className="card">
        <h3>Avatares de visitante</h3>
        <p className="comunidade-muted">
          Pool de até {dados.maxVisitorAvatars} imagens. Quem entra sem conta recebe uma delas.
          Hoje o visitante apenas lê a Comunidade — a pool fica pronta para quando a
          participação sem conta for liberada.
        </p>
        <div className="comunidade-admin-pool">
          {dados.visitorAvatars.map((a) => (
            <div key={a.id} className="comunidade-admin-pool-item">
              <span className="comunidade-avatar kind-external"><img src={a.url} alt="" /></span>
              <button
                type="button"
                className="comunidade-admin-pool-remover"
                aria-label="Remover imagem"
                disabled={ocupado}
                onClick={() => api.adminRemoveVisitorAvatar(a.id).then(onMudou).catch((e) => setErro(e.message))}
              >×</button>
            </div>
          ))}
          {dados.visitorAvatars.length < dados.maxVisitorAvatars && (
            <button
              type="button"
              className="comunidade-admin-pool-add"
              onClick={() => setRecortando('visitante')}
              disabled={ocupado}
            >+</button>
          )}
        </div>
      </div>

      {erro && <div className="alert error">{erro}</div>}

      {recortando && (
        <div className="modal-overlay" onClick={(e) => { if (e.target === e.currentTarget) setRecortando(null); }}>
          <div className="modal" style={{ maxWidth: 480 }}>
            <h3>{recortando === 'instituicao' ? 'Imagem da Associação Allos' : 'Nova imagem de visitante'}</h3>
            <PhotoCropper onCrop={salvarRecorte} onCancel={() => setRecortando(null)} />
          </div>
        </div>
      )}
    </>
  );
}
