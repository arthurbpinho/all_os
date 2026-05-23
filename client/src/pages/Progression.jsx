import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api';
import Typewriter from '../components/Typewriter';
import ProgressionChat from '../components/ProgressionChat';

export default function Progression({ user }) {
  const [step, setStep] = useState('patient'); // patient | chat | result
  const [patients, setPatients] = useState([]);
  const [selectedPatient, setSelectedPatient] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const navigate = useNavigate();

  useEffect(() => {
    async function loadPatients() {
      try {
        const data = await api.getProgressionPatients();
        setPatients(data || []);
      } catch (err) {
        setError(err.message || 'Erro ao carregar pacientes.');
      } finally {
        setLoading(false);
      }
    }
    loadPatients();
  }, [user]);

  function selectPatient(patient) {
    setSelectedPatient(patient);
    setStep('chat');
  }

  function handleEvaluationComplete(evaluation) {
    // evaluation contém: { evaluation, criteria }
    setSelectedPatient((prev) => ({ ...prev, evaluation }));
    setStep('result');
  }

  function startNewSession() {
    setStep('patient');
    setSelectedPatient(null);
  }

  // ---- Tela de resultado ----
  if (step === 'result' && selectedPatient?.evaluation) {
    return (
      <div>
        <div className="page-header">
          <div className="eyebrow">Progressão · {selectedPatient?.characterName}</div>
          <h2>Análise <span className="accent">concluída</span></h2>
          <div className="ornament" />
        </div>

        <div className="card progression-result">
          <div className="progression-evaluation">
            {selectedPatient.evaluation.evaluation && (
              <div className="progression-text">
                {selectedPatient.evaluation.evaluation}
              </div>
            )}
          </div>

          {selectedPatient.evaluation.criteria && (
            <div className="progression-scores">
              <h3>Notas por critério (Atendimento 2)</h3>
              <div className="criteria-grid">
                {Object.entries(selectedPatient.evaluation.criteria).map(([criterion, score]) => (
                  <div key={criterion} className="criterion-item">
                    <span className="criterion-label">Critério {criterion}</span>
                    <span className="criterion-score">{score}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          <div className="progression-actions">
            <button className="btn btn-primary" onClick={startNewSession}>
              Avaliar outro paciente
            </button>
            <button className="btn btn-outline" onClick={() => navigate('/simulacao')}>
              Voltar ao menu
            </button>
          </div>
        </div>
      </div>
    );
  }

  // ---- Tela de chat ----
  if (step === 'chat' && selectedPatient) {
    return (
      <ProgressionChat
        patient={selectedPatient}
        user={user}
        onEvaluationComplete={handleEvaluationComplete}
        onCancel={() => {
          setStep('patient');
          setSelectedPatient(null);
        }}
      />
    );
  }

  // ---- Tela de seleção de paciente ----
  return (
    <div>
      <div className="page-header">
        <div className="eyebrow">Sistema 2 · Progressão</div>
        <h2><Typewriter text="Pro" /><span className="accent"><Typewriter text="gressão" delayStart={140} /></span></h2>
        <p>
          Avaliação de progresso: escolha um paciente que você já atendeu antes, converse com ele novamente
          e vamos comparar como você evoluiu — ou se há pontos a revisar com seu supervisor.
        </p>
        <div className="ornament" />
      </div>

      {error && <div className="alert error">{error}<button onClick={() => setError('')} className="close">×</button></div>}

      {loading ? (
        <div className="card" style={{ textAlign: 'center', padding: '40px 24px' }}>
          <span className="spinner" /> <span style={{ marginLeft: 12, color: 'var(--ink-soft)' }}>Carregando…</span>
        </div>
      ) : patients.length === 0 ? (
        <div className="card" style={{ textAlign: 'center', padding: '40px 24px', color: 'var(--ink-soft)' }}>
          <p>Você ainda não atendeu nenhum paciente. Comece com uma Simulação Livre para criar histórico.</p>
        </div>
      ) : (
        <>
          <h3 style={{ marginBottom: 16 }}>Escolha um paciente para avaliar progresso</h3>
          <div className="card-grid">
            {patients.map((patient) => (
              <div
                key={patient.characterId}
                className="character-card"
                onClick={() => selectPatient(patient)}
              >
                <div className="character-card-header">
                  <h3>{patient.characterName}</h3>
                </div>
                <p style={{ fontSize: 13, color: 'var(--ink-soft)' }}>
                  Última interação: {new Date(patient.lastInteraction).toLocaleDateString('pt-BR')}
                </p>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
