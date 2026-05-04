import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api';
import Typewriter from '../components/Typewriter';

export default function Profile({ user, onUpdate }) {
  const navigate = useNavigate();
  const [name, setName] = useState(user.name || '');
  const [gender, setGender] = useState(user.gender || '');
  const [email, setEmail] = useState(user.email || '');
  const [profilePhoto, setProfilePhoto] = useState(user.profilePhoto || '');
  const [updateAllOS, setUpdateAllOS] = useState(!!user.updateAllOS);
  const [updateAllos, setUpdateAllos] = useState(!!user.updateAllos);
  const [photos, setPhotos] = useState([]);
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    api.getProfilePhotos()
      .then(setPhotos)
      .catch((err) => setError('Erro ao carregar fotos: ' + err.message));
  }, []);

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

      <form onSubmit={handleSave} className="profile-form">
        {/* Foto de perfil */}
        <section className="profile-section">
          <h3 className="section-title">Foto de perfil</h3>
          <div className="profile-photo-grid">
            {photos.length === 0 ? (
              <p style={{ color: 'var(--ink-soft)', fontStyle: 'italic' }}>
                Nenhuma foto disponível na pasta <code>profiles_icon</code>.
              </p>
            ) : (
              photos.map((photo) => (
                <button
                  type="button"
                  key={photo.filename}
                  className={`profile-photo-option ${profilePhoto === photo.url ? 'selected' : ''}`}
                  onClick={() => setProfilePhoto(photo.url)}
                  title={photo.label}
                >
                  <img src={photo.url} alt={photo.label} />
                  <span className="profile-photo-label">{photo.label}</span>
                </button>
              ))
            )}
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
    </div>
  );
}
