import { useState, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { api } from '../api';

// Tela de aceitar um duelo. Dois modos:
//  - por token (`/duelo/convite/:token`): link de WhatsApp / visitante. Funciona
//    pra usuário logado E pra visitante (que cai no Login antes e volta aqui).
//  - por id (`/duelo/aceitar/:id`): convite in-app, vindo da notificação.
// Ao aceitar, mostra "Você aceitou um duelo de fulano para atender X" e leva
// pra sessão.
export default function DuelAccept({ user }) {
  const { token, id } = useParams();
  const navigate = useNavigate();
  const [info, setInfo] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [accepting, setAccepting] = useState(false);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        if (token) {
          const data = await api.getDuelByToken(token);
          if (!cancelled) setInfo({
            duelId: data.id,
            status: data.status,
            challengerName: data.challengerName,
            characterName: data.character?.name,
            taken: data.opponentTaken && data.youAre !== 'opponent',
            youAre: data.youAre,
          });
        } else if (id) {
          const d = await api.getDuel(id);
          if (!cancelled) setInfo({
            duelId: d.id,
            status: d.status,
            challengerName: d.challenger?.name,
            characterName: d.character?.name,
            taken: false,
            youAre: d.youAre,
          });
        }
      } catch (err) {
        if (!cancelled) setError(err.message || 'Convite inválido ou expirado.');
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    load();
    return () => { cancelled = true; };
  }, [token, id]);

  async function accept() {
    setAccepting(true);
    setError('');
    try {
      const duel = token ? await api.acceptDuelByToken(token) : await api.acceptDuel(id);
      navigate(`/duelo/sessao/${duel.id || info.duelId}`);
    } catch (err) {
      setError(err.message || 'Não foi possível aceitar o duelo.');
      setAccepting(false);
    }
  }

  if (loading) {
    return (
      <div className="post-session">
        <div className="card" style={{ textAlign: 'center', padding: '40px 24px' }}>
          <span className="spinner" /> <span style={{ marginLeft: 12, color: 'var(--ink-soft)' }}>Carregando convite…</span>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="post-session">
        <div className="page-header">
          <div className="eyebrow">Duelo</div>
          <h2>Convite <span className="accent">indisponível</span></h2>
          <div className="ornament" />
        </div>
        <div className="alert error">{error}</div>
        <button className="btn btn-outline" onClick={() => navigate('/freeplay')}>Voltar</button>
      </div>
    );
  }

  // Já é o oponente (aceitou antes) → vai direto pra sessão.
  if (info?.youAre === 'opponent') {
    return (
      <div className="post-session">
        <div className="page-header">
          <div className="eyebrow">Duelo · {info.characterName}</div>
          <h2>Você já está <span className="accent">neste duelo</span></h2>
          <div className="ornament" />
        </div>
        <div className="card">
          <p style={{ fontSize: 15, lineHeight: 1.6 }}>
            Você aceitou um duelo de <strong>{info.challengerName}</strong> para atender <strong>{info.characterName}</strong>.
          </p>
          <button className="btn btn-primary" onClick={() => navigate(`/duelo/sessao/${info.duelId}`)}>Ir para a sessão</button>
        </div>
      </div>
    );
  }

  return (
    <div className="post-session">
      <div className="page-header">
        <div className="eyebrow">Duelo · convite</div>
        <h2>Você foi <span className="accent">desafiado</span></h2>
        <div className="ornament" />
      </div>
      <div className="card duel-accept-card">
        <p style={{ fontSize: 16, lineHeight: 1.6 }}>
          <strong>{info?.challengerName || 'Alguém'}</strong> te desafiou para um duelo:
          atender <strong>{info?.characterName}</strong>. Vocês atendem o mesmo paciente, cada
          um na sua sessão, e o avaliador comparativo decide o vencedor.
        </p>
        {info?.taken ? (
          <div className="alert">Este duelo já foi aceito por outra pessoa.</div>
        ) : info?.status === 'completed' ? (
          <div className="alert">Este duelo já foi concluído.</div>
        ) : (
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginTop: 8 }}>
            <button className="btn btn-primary btn-lg" onClick={accept} disabled={accepting}>
              {accepting ? 'Aceitando…' : 'Aceitar e atender'}
            </button>
            <button className="btn btn-outline btn-lg" onClick={() => navigate('/freeplay')} disabled={accepting}>
              Agora não
            </button>
          </div>
        )}
        {user?.role === 'visitor' && (
          <p style={{ color: 'var(--muted)', fontSize: 12.5, marginTop: 14 }}>
            Você está em modo visitante — joga este duelo sem precisar de conta.
          </p>
        )}
      </div>
    </div>
  );
}
