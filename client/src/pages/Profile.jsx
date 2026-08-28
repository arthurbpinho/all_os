import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api';
import Typewriter from '../components/Typewriter';
import PhotoCropper from '../components/PhotoCropper';
import RichText from '../components/RichText';
import DevTooltip from '../components/DevTooltip';

// Balões das partes do Perfil que ainda estão em construção. Mesmo vocabulário
// do menu lateral (ver NavEmDesenvolvimento em App.jsx): cinza + explicação.
const DESC_DESCRICAO_VISUAL =
  'Funcionalidade para interação do paciente com sua descrição visual em tempo real na sessão.';
const DESC_ABORDAGEM =
  'Conduziremos pesquisas em psicologia comparada a partir dos dados gerados pelos usuários.';

export default function Profile({ user, onUpdate, onLogout }) {
  const navigate = useNavigate();
  const [name, setName] = useState(user.name || '');
  // Troca de e-mail (fluxo próprio, ver mais abaixo). O campo do formulário
  // principal não salva mais o e-mail: ele virou a âncora do "esqueci minha
  // senha", e salvá-lo junto com nome e foto permitiria a uma sessão roubada
  // apontar o e-mail pra si e pedir reset.
  const [novoEmail, setNovoEmail] = useState('');
  const [senhaParaEmail, setSenhaParaEmail] = useState('');
  const [emailMsg, setEmailMsg] = useState('');
  const [emailErro, setEmailErro] = useState('');
  const [trocandoEmail, setTrocandoEmail] = useState(false);
  const [profilePhoto, setProfilePhoto] = useState(user.profilePhoto || '');
  // Aparência: consentimento de mostrar aos pacientes simulados + descrição
  // visual gerada por IA (gpt-5.4-mini). Por ora só vive no perfil.
  const [shareAppearance, setShareAppearance] = useState(!!user.shareAppearance);
  const [visualDescription, setVisualDescription] = useState(user.visualDescription || '');
  const [generatingDesc, setGeneratingDesc] = useState(false);
  const [descError, setDescError] = useState('');
  const [showConsentModal, setShowConsentModal] = useState(false);
  const [updateAllOS, setUpdateAllOS] = useState(!!user.updateAllOS);
  const [updateAllos, setUpdateAllos] = useState(!!user.updateAllos);
  const [showCropper, setShowCropper] = useState(false);
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState(null);
  const [error, setError] = useState('');
  const [gamification, setGamification] = useState(null);
  // Exercícios (as antigas sidequests): a pessoa escolhe se quer receber um
  // objetivo junto do atendimento. Ausente = ligado (contas antigas).
  const [sidequestsEnabled, setSidequestsEnabled] = useState(user.sidequestsEnabled !== false);
  const [abordagem, setAbordagem] = useState(user.abordagem || '');
  // MMR competitivo, mostrado aqui em vez de só no Ranking.
  const [mmr, setMmr] = useState(null);

  // Troca de senha
  const [pwdCurrent, setPwdCurrent] = useState('');
  const [pwdNew, setPwdNew] = useState('');
  const [pwdConfirm, setPwdConfirm] = useState('');
  const [pwdSaving, setPwdSaving] = useState(false);
  const [pwdError, setPwdError] = useState('');
  const [pwdSuccess, setPwdSuccess] = useState('');

  // Exclusão da própria conta
  const [showDeleteModal, setShowDeleteModal] = useState(false);
  const [deleteConfirmText, setDeleteConfirmText] = useState('');
  const [deletePassword, setDeletePassword] = useState('');
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState('');

  // Título (subtítulo) desbloqueável exibido sob o nome / no ranking
  const [activeTitle, setActiveTitle] = useState(user.activeTitle || '');
  const [titleSaving, setTitleSaving] = useState(false);
  const [titleError, setTitleError] = useState('');

  async function selectTitle(id) {
    const next = id === activeTitle ? '' : id; // clicar no ativo limpa
    setTitleError('');
    setTitleSaving(true);
    try {
      const updated = await api.setMyTitle(next);
      setActiveTitle(updated.activeTitle || '');
      onUpdate(updated);
    } catch (err) {
      setTitleError(err.message || 'Erro ao definir título.');
    } finally {
      setTitleSaving(false);
    }
  }

  async function handleChangePassword(e) {
    e.preventDefault();
    setPwdError(''); setPwdSuccess('');
    if (!pwdCurrent || !pwdNew) return setPwdError('Preencha senha atual e nova.');
    // Checagem grosseira; a política completa (piso por perfil, letra, número,
    // símbolo, não conter o username) é do servidor, e a mensagem dele é a que
    // aparece aqui.
    if (pwdNew.length < 8) return setPwdError('Nova senha deve ter ao menos 8 caracteres.');
    if (pwdNew !== pwdConfirm) return setPwdError('A confirmação não confere.');
    setPwdSaving(true);
    try {
      // O api.changeMyPassword já guarda o token novo que vem na resposta —
      // trocar a senha invalida todos os anteriores, inclusive o desta aba.
      await api.changeMyPassword(pwdCurrent, pwdNew);
      setPwdSuccess('Senha alterada. As sessões abertas em outros aparelhos foram encerradas.');
      setPwdCurrent(''); setPwdNew(''); setPwdConfirm('');
      setTimeout(() => setPwdSuccess(''), 4000);
    } catch (err) {
      setPwdError(err.message || 'Erro ao trocar senha.');
    } finally {
      setPwdSaving(false);
    }
  }

  function openDeleteModal() {
    setDeleteError('');
    setDeleteConfirmText('');
    setDeletePassword('');
    setShowDeleteModal(true);
  }

  function closeDeleteModal() {
    if (deleting) return;
    setShowDeleteModal(false);
  }

  async function handleDeleteAccount() {
    setDeleteError('');
    if (deleteConfirmText.trim().toUpperCase() !== 'EXCLUIR') {
      setDeleteError('Digite EXCLUIR para confirmar.');
      return;
    }
    if (!deletePassword) {
      setDeleteError('Digite sua senha atual.');
      return;
    }
    setDeleting(true);
    try {
      await api.deleteMyAccount(deletePassword);
      // A conta já não existe mais no servidor — sai da sessão local e vai
      // pro login, igual ao "Sair" comum.
      onLogout();
    } catch (err) {
      setDeleteError(err.message || 'Não foi possível excluir a conta.');
      setDeleting(false);
    }
  }

  useEffect(() => {
    api.getGamification(user.id)
      .then(setGamification)
      .catch(() => {});
    api.getMyMmr()
      .then(setMmr)
      .catch(() => {}); // sem MMR ainda, o bloco simplesmente não aparece
  }, [user.id]);

  const earnedBadges = gamification?.achievements?.filter((a) => a.earned) || [];
  // Só conquistas de OURO (ou recompensas de missão) podem virar título de perfil.
  const titleEligible = earnedBadges.filter((a) => a.tier === 'gold' || a.sidequest);
  const streak = gamification?.streak;

  async function handleTrocarEmail() {
    setEmailErro('');
    setEmailMsg('');
    setTrocandoEmail(true);
    try {
      const res = await api.trocarMeuEmail(senhaParaEmail, novoEmail.trim());
      setEmailMsg(`Mandamos um link de confirmação para ${res.aguardandoConfirmacao}. Até você clicar nele, seu e-mail atual continua valendo.`);
      setNovoEmail('');
      setSenhaParaEmail('');
    } catch (err) {
      setEmailErro(err.message || 'Não foi possível solicitar a troca.');
    } finally {
      setTrocandoEmail(false);
    }
  }

  async function handleSave(e) {
    e.preventDefault();
    setSaving(true);
    setError('');
    try {
      const updated = await api.updateUser(user.id, {
        name: name.trim(),
        profilePhoto,
        shareAppearance,
        visualDescription,
        updateAllOS,
        updateAllos,
        sidequestsEnabled,
      });
      onUpdate(updated);
      setSavedAt(new Date());
      setTimeout(() => setSavedAt(null), 3000);
    } catch (err) {
      setError(err.message || 'Erro ao salvar');
    } finally {
      setSaving(false);
    }
  }

  function handleCropDone(dataUrl) {
    setProfilePhoto(dataUrl);
    setShowCropper(false);
    // Nova foto → re-perguntar o consentimento e descartar a descrição antiga.
    setShareAppearance(false);
    setVisualDescription('');
    setDescError('');
  }

  function handleRemovePhoto() {
    if (!window.confirm('Remover a foto de perfil?')) return;
    setProfilePhoto('');
    setShareAppearance(false);
    setVisualDescription('');
    setDescError('');
  }

  async function generateVisualDescription(photo) {
    if (!photo) {
      setDescError('Adicione uma foto de perfil primeiro.');
      setShareAppearance(false);
      return;
    }
    setDescError('');
    setGeneratingDesc(true);
    try {
      const { description } = await api.describeAppearance(photo);
      setVisualDescription(description || '');
    } catch (err) {
      setDescError(err.message || 'Erro ao gerar a descrição visual.');
      setShareAppearance(false);
    } finally {
      setGeneratingDesc(false);
    }
  }

  // Marcar o consentimento abre o aviso de LGPD antes de gerar — a geração só
  // acontece se a pessoa confirmar (Sim). Desmarcar limpa a descrição (ela só
  // existe com o "sim").
  function handleToggleAppearance(checked) {
    setDescError('');
    if (checked) {
      setShowConsentModal(true);
    } else {
      setShareAppearance(false);
      setVisualDescription('');
    }
  }

  // Confirmou o aviso (Sim) → consente e gera a descrição.
  function confirmConsent() {
    setShowConsentModal(false);
    setShareAppearance(true);
    generateVisualDescription(profilePhoto);
  }

  // Recusou (Não) → fecha o aviso e deixa tudo como estava (sem consentir,
  // sem gerar, campo inalterado).
  function cancelConsent() {
    setShowConsentModal(false);
  }

  return (
    <div className="profile-page">
      <div className="page-header">
        <div className="eyebrow">Sua conta</div>
        <h2>
          <Typewriter text="Perfil de " />
          <span className="accent"><Typewriter text={name || user.name} delayStart={500} /></span>
        </h2>
        {(() => {
          const activeBadge = earnedBadges.find((a) => a.id === activeTitle);
          return activeBadge ? (
            <div className={`player-title tier-${activeBadge.tier} profile-active-title`}>
              {activeBadge.icon} {activeBadge.title}
            </div>
          ) : null;
        })()}
        <p>Personalize suas preferências, foto e como você quer receber novidades da Allos.</p>
        <div className="ornament" />
      </div>

      {error && <div className="alert error">{error}</div>}

      {(streak?.status === 'monthly' || streak?.status === 'weekly' || earnedBadges.length > 0) && (
        <section className="profile-section" style={{ marginBottom: 24 }}>
          <h3 className="section-title">Metas alcançadas</h3>

          {streak?.status === 'monthly' && (
            <div className="streak-badge monthly" style={{ marginBottom: 14 }}>
              <span className="badge-flame">●</span>
              Constância mensal · {streak.current} {streak.current === 1 ? 'semana' : 'semanas'}
            </div>
          )}
          {streak?.status === 'weekly' && (
            <div className="streak-badge weekly" style={{ marginBottom: 14 }}>
              <span className="badge-flame">●</span>
              Constância semanal · {streak.current} {streak.current === 1 ? 'semana' : 'semanas'}
            </div>
          )}

          {earnedBadges.length === 0 ? (
            <p style={{ color: 'var(--ink-soft)', fontSize: 13.5 }}>
              Nenhuma meta alcançada ainda. Conclua os objetivos diários e mantenha a constância para registrar marcos.
            </p>
          ) : (
            <div className="achievement-grid" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(150px, 1fr))' }}>
              {earnedBadges.map((a) => (
                <div key={a.id} className={`achievement-card tier-${a.tier} earned`} title={a.description}>
                  <div className="achievement-icon">{a.icon}</div>
                  <div className="achievement-title">{a.title}</div>
                  {a.earnedAt && (
                    <div className="achievement-date">
                      {new Date(a.earnedAt).toLocaleDateString('pt-BR')}
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}

          {titleEligible.length > 0 && (
            <div style={{ marginTop: 22 }}>
              <h4 className="section-title" style={{ fontSize: 15 }}>Título exibido</h4>
              <p style={{ color: 'var(--ink-soft)', fontSize: 13.5, marginBottom: 12 }}>
                Só conquistas de <strong>ouro</strong> (e recompensas de missão) viram título. Escolha um para exibir sob o seu nome no perfil e no ranking. Clique no ativo para remover.
              </p>
              {titleError && <div className="alert error" style={{ marginBottom: 10 }}>{titleError}</div>}
              <div className="title-chips">
                <button
                  type="button"
                  className={`title-chip ${!activeTitle ? 'active' : ''}`}
                  onClick={() => selectTitle('')}
                  disabled={titleSaving || !activeTitle}
                >
                  Nenhum
                </button>
                {titleEligible.map((a) => (
                  <button
                    key={a.id}
                    type="button"
                    className={`title-chip tier-${a.tier} ${activeTitle === a.id ? 'active' : ''}`}
                    onClick={() => selectTitle(a.id)}
                    disabled={titleSaving}
                    title={a.description}
                  >
                    {a.icon} {a.title}
                  </button>
                ))}
              </div>
            </div>
          )}
        </section>
      )}

      <form onSubmit={handleSave} className="profile-form">
        {/* MMR — a mesma medida do Ranking, aqui como leitura da própria conta.
            Some durante a calibração? Não: mostrar quantas partidas faltam é
            justamente o que explica por que ainda não há número. */}
        {mmr && (
          <section className="profile-section">
            <h3 className="section-title">MMR</h3>
            <div className="perfil-mmr">
              <div className="perfil-mmr-valor">
                {mmr.calibrating ? '—' : mmr.mmr}
              </div>
              <div className="perfil-mmr-texto">
                {mmr.calibrating ? (
                  <>
                    <strong>Em calibração.</strong>{' '}
                    {mmr.matchesRemaining === 1
                      ? 'Falta 1 atendimento no modo Simulação para o seu MMR aparecer.'
                      : `Faltam ${mmr.matchesRemaining} atendimentos no modo Simulação para o seu MMR aparecer.`}
                  </>
                ) : (
                  <>
                    Medida de habilidade do modo Simulação, calculada a partir da nota e da
                    dificuldade de cada paciente. {mmr.n} {mmr.n === 1 ? 'partida contabilizada' : 'partidas contabilizadas'}.
                  </>
                )}
              </div>
            </div>
          </section>
        )}

        {/* Exercícios (as antigas sidequests). O interruptor não cancela o que o
            supervisor atribuiu — só para de servir o objetivo no atendimento. */}
        <section className="profile-section">
          <h3 className="section-title">Exercícios</h3>
          <p style={{ color: 'var(--ink-soft)', fontSize: 13.5, marginBottom: 10 }}>
            Exercícios são objetivos clínicos que entram junto do atendimento e viram o foco
            da sessão — conduzir uma devolutiva, sustentar um silêncio, e assim por diante.
          </p>
          <label className="checkbox-row">
            <input
              type="checkbox"
              checked={sidequestsEnabled}
              onChange={(e) => setSidequestsEnabled(e.target.checked)}
            />
            <span>
              <strong>Atender com exercício</strong>
              <br />
              <span style={{ color: 'var(--ink-soft)', fontSize: 13 }}>
                Desligado, você atende sem nenhum objetivo extra. Um exercício que o seu
                supervisor tenha atribuído continua guardado e volta quando você religar.
              </span>
            </span>
          </label>
        </section>

        {/* Foto de perfil */}
        <section className="profile-section">
          <h3 className="section-title">Foto de perfil</h3>

          <div className="cropper-current">
            {profilePhoto ? (
              <img src={profilePhoto} alt="Foto atual" />
            ) : (
              <div className="cropper-current-empty">sem foto</div>
            )}
            <div style={{ flex: 1 }}>
              <p style={{ color: 'var(--ink-soft)', fontSize: 13.5, marginBottom: 10 }}>
                Faça upload de um PNG ou JPG. Você pode arrastar e dar zoom para enquadrar a imagem
                no formato quadrado do perfil.
              </p>
              <div style={{ display: 'flex', gap: 8 }}>
                <button type="button" className="btn btn-outline btn-sm" onClick={() => setShowCropper(true)}>
                  {profilePhoto ? 'Trocar foto' : 'Fazer upload'}
                </button>
                {profilePhoto && (
                  <button type="button" className="btn btn-ghost btn-sm" onClick={handleRemovePhoto}>
                    Remover
                  </button>
                )}
              </div>
            </div>
          </div>

          {/* Consentimento de aparência + descrição visual gerada por IA. */}
          {profilePhoto && (
            <label className="checkbox-row visual-consent">
              <input
                type="checkbox"
                checked={shareAppearance}
                onChange={(e) => handleToggleAppearance(e.target.checked)}
                disabled={generatingDesc}
              />
              <span>Você gostaria que seus pacientes simulados conheçam sua aparência?</span>
            </label>
          )}

          <div className="visual-desc bloco-dev">
            <label className="visual-desc-label">
              Descrição visual
              <DevTooltip text={DESC_DESCRICAO_VISUAL} abrirNoToque>
                <span className="dev-etiqueta" tabIndex={0}>Em desenvolvimento</span>
              </DevTooltip>
            </label>
            <div className={`visual-desc-box ${visualDescription && !generatingDesc ? '' : 'empty'}`} aria-readonly="true" tabIndex={-1}>
              {generatingDesc ? (
                <span className="visual-desc-loading"><span className="spinner" /> Gerando descrição visual…</span>
              ) : visualDescription ? (
                <RichText text={visualDescription} />
              ) : (
                'Adicione uma foto de perfil para obter uma descrição visual para utilizar como aparência nos casos com seu paciente'
              )}
            </div>
            {descError && <div className="alert error" style={{ marginTop: 8 }}>{descError}</div>}
          </div>
        </section>

        {/* Identidade */}
        <section className="profile-section">
          <h3 className="section-title">Identidade</h3>
          <div className="profile-row">
            <div style={{ flex: 1 }}>
              <label htmlFor="name">Nome de exibição</label>
              <input id="name" type="text" value={name} onChange={(e) => setName(e.target.value)} placeholder="Como deseja ser chamado(a)" />
            </div>
          </div>

          {/* Abordagem teórica. Em construção: o campo aparece para todos —
              mostrar o que vem é o ponto — mas ainda não é editável nem salvo
              (o servidor aceita o campo; a tela é que o mantém fechado). */}
          <div className="profile-row bloco-dev" style={{ marginTop: 14 }}>
            <div style={{ flex: 1 }}>
              <label htmlFor="abordagem">
                Abordagem
                <DevTooltip text={DESC_ABORDAGEM} abrirNoToque>
                  <span className="dev-etiqueta" tabIndex={0}>Em desenvolvimento</span>
                </DevTooltip>
              </label>
              <input
                id="abordagem"
                type="text"
                value={abordagem}
                readOnly
                placeholder="Psicanálise, TCC, Fenomenológica…"
              />
            </div>
          </div>
        </section>

        {/* Comunicação */}
        <section className="profile-section">
          <h3 className="section-title">Comunicação</h3>
          <div>
            <label>E-mail da conta</label>
            <div className="email-atual">
              <strong>{user.email || 'nenhum e-mail cadastrado'}</strong>
              {user.email && (
                <span className={user.emailVerified ? 'selo-ok' : 'selo-pendente'}>
                  {user.emailVerified ? 'confirmado' : 'não confirmado'}
                </span>
              )}
            </div>
            <small style={{ display: 'block', marginTop: 6, color: 'var(--muted)', fontSize: 12.5, lineHeight: 1.6 }}>
              É por este endereço que você recupera o acesso se esquecer a senha. Trocar exige
              sua senha atual e a confirmação do endereço novo por link — até confirmar, o atual
              continua valendo.
            </small>

            <div className="trocar-email">
              <input
                type="email" value={novoEmail} onChange={(e) => setNovoEmail(e.target.value)}
                placeholder="novo e-mail" autoComplete="email" autoCapitalize="none" spellCheck="false"
              />
              <input
                type="password" value={senhaParaEmail} onChange={(e) => setSenhaParaEmail(e.target.value)}
                placeholder="sua senha atual" autoComplete="current-password"
              />
              <button
                type="button" className="btn btn-outline btn-sm"
                disabled={trocandoEmail || !novoEmail.trim() || !senhaParaEmail}
                onClick={handleTrocarEmail}
              >
                {trocandoEmail ? 'Enviando…' : 'Trocar e-mail'}
              </button>
            </div>
            {emailErro && <div className="alert error" style={{ marginTop: 8 }}>{emailErro}</div>}
            {emailMsg && <div className="alert" style={{ marginTop: 8 }}>{emailMsg}</div>}
          </div>

          <div className="profile-checkbox-group">
            <label className="checkbox-row">
              <input type="checkbox" checked={updateAllOS} onChange={(e) => setUpdateAllOS(e.target.checked)} />
              <span>
                <strong>all_OS</strong> — autorizo receber novidades, melhorias e atualizações desta plataforma de simulação clínica.
              </span>
            </label>
            <label className="checkbox-row">
              <input type="checkbox" checked={updateAllos} onChange={(e) => setUpdateAllos(e.target.checked)} />
              <span>
                <strong>Allos</strong> — autorizo receber novidades sobre todos os produtos e serviços da Associação Allos (cursos, eventos, clínica, comunidade).
              </span>
            </label>
          </div>
        </section>

        <div className="profile-actions">
          <button type="button" className="btn btn-outline" onClick={() => navigate(-1)}>Cancelar</button>
          <button type="submit" className="btn btn-primary" disabled={saving}>
            {saving ? 'Salvando…' : 'Salvar alterações'}
          </button>
          {savedAt && <span className="profile-saved">Salvo às {savedAt.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}.</span>}
        </div>
      </form>

      <section className="profile-section" style={{ marginTop: 24 }}>
        <h3 className="section-title">Segurança</h3>
        <p style={{ color: 'var(--ink-soft)', fontSize: 13.5, marginBottom: 12 }}>
          Troque sua senha de acesso. Recomendamos pelo menos 8 caracteres.
        </p>
        <form onSubmit={handleChangePassword} style={{ display: 'grid', gap: 12, maxWidth: 460 }}>
          <div>
            <label htmlFor="pwd-current">Senha atual</label>
            <input
              id="pwd-current"
              type="password"
              value={pwdCurrent}
              onChange={(e) => setPwdCurrent(e.target.value)}
              autoComplete="current-password"
            />
          </div>
          <div>
            <label htmlFor="pwd-new">Nova senha</label>
            <input
              id="pwd-new"
              type="password"
              value={pwdNew}
              onChange={(e) => setPwdNew(e.target.value)}
              autoComplete="new-password"
            />
          </div>
          <div>
            <label htmlFor="pwd-confirm">Confirme a nova senha</label>
            <input
              id="pwd-confirm"
              type="password"
              value={pwdConfirm}
              onChange={(e) => setPwdConfirm(e.target.value)}
              autoComplete="new-password"
            />
          </div>
          {pwdError && <div className="alert error">{pwdError}</div>}
          {pwdSuccess && <div className="alert" style={{ background: 'var(--olive-tint, #efe)', color: 'var(--olive-deep, #363)' }}>{pwdSuccess}</div>}
          <div>
            <button type="submit" className="btn btn-primary" disabled={pwdSaving}>
              {pwdSaving ? 'Salvando…' : 'Trocar senha'}
            </button>
          </div>
        </form>
      </section>

      <section className="profile-section profile-danger" style={{ marginTop: 24 }}>
        <h3 className="section-title">Excluir conta</h3>
        <p style={{ color: 'var(--ink-soft)', fontSize: 13.5, marginBottom: 12, lineHeight: 1.6 }}>
          Isso encerra seu acesso e remove sua conta do all_OS — não é possível desfazer. Suas
          sessões, avaliações e conversas registradas continuam guardadas (fazem parte do
          histórico de supervisão e de pesquisa da Allos); para pedir a exclusão delas, envie um
          e-mail para <strong>suporte@allos.org.br</strong>. Leia mais na{' '}
          <a href="/politica-de-privacidade" target="_blank" rel="noopener noreferrer">política de privacidade</a>.
        </p>
        <button type="button" className="btn btn-danger" onClick={openDeleteModal}>
          Excluir minha conta
        </button>
      </section>

      {showConsentModal && (
        <div className="modal-overlay" onClick={(e) => { if (e.target === e.currentTarget) cancelConsent(); }}>
          <div className="modal" style={{ maxWidth: 460 }}>
            <h3>Gerar descrição visual</h3>
            <p style={{ color: 'var(--ink-soft)', fontSize: 14, lineHeight: 1.6, marginTop: -2, marginBottom: 18 }}>
              <strong>Atenção:</strong> Ao confirmar você aceita que seus dados sejam processados pela OpenAI
              e pelo aplicativo para criação da descrição visual. Você deseja continuar?
            </p>
            <div className="modal-actions">
              <button type="button" className="btn btn-outline" onClick={cancelConsent}>Não</button>
              <button type="button" className="btn btn-primary" onClick={confirmConsent}>Sim</button>
            </div>
          </div>
        </div>
      )}

      {showDeleteModal && (
        <div className="modal-overlay" onClick={(e) => { if (e.target === e.currentTarget) closeDeleteModal(); }}>
          <div className="modal" style={{ maxWidth: 460 }}>
            <h3>Excluir sua conta</h3>
            <p style={{ color: 'var(--ink-soft)', fontSize: 14, lineHeight: 1.6, marginTop: -2, marginBottom: 16 }}>
              <strong>Esta ação não pode ser desfeita.</strong> Você perde o acesso ao all_OS
              imediatamente. Para confirmar, digite <strong>EXCLUIR</strong> e sua senha atual.
            </p>
            <div style={{ display: 'grid', gap: 12 }}>
              <div>
                <label htmlFor="del-confirm">Digite EXCLUIR para confirmar</label>
                <input
                  id="del-confirm"
                  type="text"
                  value={deleteConfirmText}
                  onChange={(e) => setDeleteConfirmText(e.target.value)}
                  autoComplete="off"
                  autoFocus
                />
              </div>
              <div>
                <label htmlFor="del-password">Sua senha atual</label>
                <input
                  id="del-password"
                  type="password"
                  value={deletePassword}
                  onChange={(e) => setDeletePassword(e.target.value)}
                  autoComplete="current-password"
                />
              </div>
            </div>
            {deleteError && <div className="alert error" style={{ marginTop: 12 }}>{deleteError}</div>}
            <div className="modal-actions">
              <button type="button" className="btn btn-outline" onClick={closeDeleteModal} disabled={deleting}>
                Cancelar
              </button>
              <button
                type="button"
                className="btn btn-danger"
                onClick={handleDeleteAccount}
                disabled={deleting || deleteConfirmText.trim().toUpperCase() !== 'EXCLUIR' || !deletePassword}
              >
                {deleting ? 'Excluindo…' : 'Excluir definitivamente'}
              </button>
            </div>
          </div>
        </div>
      )}

      {showCropper && (
        <div className="modal-overlay" onClick={(e) => { if (e.target === e.currentTarget) setShowCropper(false); }}>
          <div className="modal" style={{ maxWidth: 480 }}>
            <h3>Ajustar foto de perfil</h3>
            <PhotoCropper
              onCrop={handleCropDone}
              onCancel={() => setShowCropper(false)}
            />
          </div>
        </div>
      )}
    </div>
  );
}
