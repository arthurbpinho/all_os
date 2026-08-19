import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api';
import Typewriter from '../components/Typewriter';
import PhotoCropper from '../components/PhotoCropper';
import RichText from '../components/RichText';

export default function Profile({ user, onUpdate }) {
  const navigate = useNavigate();
  const [name, setName] = useState(user.name || '');
  const [email, setEmail] = useState(user.email || '');
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

  // Troca de senha
  const [pwdCurrent, setPwdCurrent] = useState('');
  const [pwdNew, setPwdNew] = useState('');
  const [pwdConfirm, setPwdConfirm] = useState('');
  const [pwdSaving, setPwdSaving] = useState(false);
  const [pwdError, setPwdError] = useState('');
  const [pwdSuccess, setPwdSuccess] = useState('');

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
    if (pwdNew.length < 6) return setPwdError('Nova senha deve ter ao menos 6 caracteres.');
    if (pwdNew !== pwdConfirm) return setPwdError('A confirmação não confere.');
    setPwdSaving(true);
    try {
      await api.changeMyPassword(pwdCurrent, pwdNew);
      setPwdSuccess('Senha alterada com sucesso.');
      setPwdCurrent(''); setPwdNew(''); setPwdConfirm('');
      setTimeout(() => setPwdSuccess(''), 4000);
    } catch (err) {
      setPwdError(err.message || 'Erro ao trocar senha.');
    } finally {
      setPwdSaving(false);
    }
  }

  useEffect(() => {
    api.getGamification(user.id)
      .then(setGamification)
      .catch(() => {});
  }, [user.id]);

  const earnedBadges = gamification?.achievements?.filter((a) => a.earned) || [];
  // Só conquistas de OURO (ou recompensas de missão) podem virar título de perfil.
  const titleEligible = earnedBadges.filter((a) => a.tier === 'gold' || a.sidequest);
  const streak = gamification?.streak;

  async function handleSave(e) {
    e.preventDefault();
    setSaving(true);
    setError('');
    try {
      const updated = await api.updateUser(user.id, {
        name: name.trim(),
        email: email.trim(),
        profilePhoto,
        shareAppearance,
        visualDescription,
        updateAllOS,
        updateAllos,
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

          <div className="visual-desc">
            <label className="visual-desc-label">Descrição visual</label>
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
        </section>

        {/* Comunicação */}
        <section className="profile-section">
          <h3 className="section-title">Comunicação</h3>
          <div>
            <label htmlFor="email">E-mail para atualizações</label>
            <input id="email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="seunome@dominio.com" />
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
