import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api';
import Typewriter from '../components/Typewriter';
import PhotoCropper from '../components/PhotoCropper';

export default function Profile({ user, onUpdate }) {
  const navigate = useNavigate();
  const [name, setName] = useState(user.name || '');
  const [gender, setGender] = useState(user.gender || '');
  const [email, setEmail] = useState(user.email || '');
  const [profilePhoto, setProfilePhoto] = useState(user.profilePhoto || '');
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
  const streak = gamification?.streak;

  async function handleSave(e) {
    e.preventDefault();
    setSaving(true);
    setError('');
    try {
      const updated = await api.updateUser(user.id, {
        name: name.trim(),
        gender,
        email: email.trim(),
        profilePhoto,
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
  }

  function handleRemovePhoto() {
    if (!window.confirm('Remover a foto de perfil?')) return;
    setProfilePhoto('');
  }

  return (
    <div className="profile-page">
      <div className="page-header">
        <div className="eyebrow">Sua conta</div>
        <h2>
          <Typewriter text="Perfil de " />
          <span className="accent"><Typewriter text={name || user.name} delayStart={500} /></span>
        </h2>
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
              Constância mensal · {streak.current} dias
            </div>
          )}
          {streak?.status === 'weekly' && (
            <div className="streak-badge weekly" style={{ marginBottom: 14 }}>
              <span className="badge-flame">●</span>
              Constância semanal · {streak.current} dias
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
        </section>

        {/* Identidade */}
        <section className="profile-section">
          <h3 className="section-title">Identidade</h3>
          <div className="profile-row">
            <div style={{ flex: 2 }}>
              <label htmlFor="name">Nome de exibição</label>
              <input id="name" type="text" value={name} onChange={(e) => setName(e.target.value)} placeholder="Como deseja ser chamado(a)" />
            </div>
            <div style={{ flex: 1 }}>
              <label>Gênero</label>
              <div className="gender-toggle">
                <button
                  type="button"
                  className={`gender-option ${gender === 'masculino' ? 'active' : ''}`}
                  onClick={() => setGender('masculino')}
                >
                  Masculino
                </button>
                <button
                  type="button"
                  className={`gender-option ${gender === 'feminino' ? 'active' : ''}`}
                  onClick={() => setGender('feminino')}
                >
                  Feminino
                </button>
              </div>
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
