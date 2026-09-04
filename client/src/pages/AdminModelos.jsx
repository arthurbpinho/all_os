import { useState, useEffect } from 'react';
import { api } from '../api';
import Typewriter from '../components/Typewriter';

// Administração → Modelos de IA. Três coisas nesta tela:
//   1. o toggle "Avaliação para visitantes" (veio da aba Contas, onde não tinha
//      muito a ver com gestão de usuários);
//   2. o PADRÃO GLOBAL — avaliador e paciente de todas as categorias de uma vez,
//      pra não ter de configurar uma por uma;
//   3. por CATEGORIA do app, qual IA avalia a sessão e qual interpreta o
//      paciente simulado (a escolha da categoria vence o padrão global).
//
// A Trilha NÃO aparece aqui de propósito: lá a escolha é por exercício, no
// editor de Exercícios da Trilha. Duplicar aqui criaria duas fontes de verdade
// para a mesma coisa.

// Chip de estado (ligado/desligado, batch, padrão do sistema).
function Chip({ children, tone = 'neutro', title }) {
  const cores = {
    neutro: { bg: 'var(--sand, #e7e2d8)', fg: 'var(--ink-soft)' },
    ok: { bg: 'var(--success, #1f8a4c)', fg: '#fff' },
    info: { bg: 'color-mix(in srgb, var(--accent, #7a5cff) 16%, transparent)', fg: 'var(--accent, #7a5cff)' },
  }[tone];
  return (
    <span
      title={title}
      style={{
        fontSize: 11.5, fontWeight: 600, padding: '2px 8px', borderRadius: 999,
        background: cores.bg, color: cores.fg, whiteSpace: 'nowrap',
      }}
    >
      {children}
    </span>
  );
}

// Uma linha de escolha (avaliador ou paciente) dentro do cartão da categoria.
// `spec` é o que o servidor diz que está rodando agora — inclusive quando não há
// escolha salva (aí fonte === 'padrão' e mostramos o modelo real, com effort).
function EscolhaModelo({ titulo, ajuda, spec, opcoes, valor, onChange, salvando, padraoLabel = 'Padrão do sistema' }) {
  return (
    <div style={{ minWidth: 260, flex: '1 1 280px' }}>
      <label style={{ fontSize: 13, fontWeight: 600, margin: 0, display: 'block', marginBottom: 4 }}>
        {titulo}
      </label>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <select
          value={valor}
          onChange={(e) => onChange(e.target.value)}
          disabled={salvando}
          style={{ width: 'auto', fontSize: 13, minWidth: 190 }}
        >
          {/* Sempre presente, pra dar caminho de volta: escolher isto limpa a
              escolha da categoria e a devolve ao padrão vigente — o global, se
              houver, senão o do sistema (que pode ter effort diferente dos
              presets, como o neuro em 'low'). */}
          <option value="">{padraoLabel}</option>
          {opcoes.map((o) => (
            <option key={o.key} value={o.key}>{o.label}</option>
          ))}
        </select>
        {salvando && <span style={{ fontSize: 12, color: 'var(--ink-soft)' }}>Salvando…</span>}
      </div>
      <div style={{ fontSize: 12, color: 'var(--ink-soft)', marginTop: 6, lineHeight: 1.5 }}>
        {ajuda}
        <div style={{ marginTop: 2 }}>
          Rodando agora: <code style={{ fontSize: 11.5 }}>{spec.model}</code>
          {spec.effort ? <> · effort <code style={{ fontSize: 11.5 }}>{spec.effort}</code></> : null}
          {spec.fonte === 'padrao' && <> · <span style={{ fontStyle: 'italic' }}>padrão do sistema</span></>}
          {spec.fonte === 'global' && <> · <span style={{ fontStyle: 'italic' }}>padrão global</span></>}
        </div>
      </div>
    </div>
  );
}

export default function AdminModelos() {
  const [catalogo, setCatalogo] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  // Qual campo está salvando: "<categoria>:<avaliador|paciente>".
  const [salvando, setSalvando] = useState('');

  // Toggle de avaliação para visitantes (eventos/palestras). Default off.
  const [visitorEval, setVisitorEval] = useState(false);
  const [visitorEvalSaving, setVisitorEvalSaving] = useState(false);
  const [visitorEvalError, setVisitorEvalError] = useState('');

  useEffect(() => {
    let cancelado = false;
    Promise.all([api.getAiModels(), api.getSettings()])
      .then(([cat, s]) => {
        if (cancelado) return;
        setCatalogo(cat);
        setVisitorEval(!!s.visitorEvaluationEnabled);
      })
      .catch((err) => { if (!cancelado) setError(err.message || 'Erro ao carregar os modelos.'); })
      .finally(() => { if (!cancelado) setLoading(false); });
    return () => { cancelado = true; };
  }, []);

  async function toggleVisitorEval() {
    if (visitorEvalSaving) return;
    const next = !visitorEval;
    setVisitorEvalSaving(true);
    setVisitorEvalError('');
    try {
      const s = await api.adminUpdateSettings({ visitorEvaluationEnabled: next });
      setVisitorEval(!!s.visitorEvaluationEnabled);
    } catch (err) {
      setVisitorEvalError(err.message || 'Erro ao salvar configuração.');
    } finally {
      setVisitorEvalSaving(false);
    }
  }

  // Grava a escolha e substitui o catálogo pelo que o servidor devolveu — assim
  // os chips de batch e o "rodando agora" refletem a decisão real do servidor,
  // não um palpite do cliente.
  async function salvar(categoria, campo, valor) {
    const chave = `${categoria}:${campo}`;
    setSalvando(chave);
    setError('');
    try {
      const payload = { categoria };
      payload[campo === 'avaliador' ? 'evaluator' : 'patient'] = valor === '' ? null : valor;
      setCatalogo(await api.setAiModel(payload));
    } catch (err) {
      setError(err.message || 'Erro ao salvar o modelo.');
    } finally {
      setSalvando('');
    }
  }

  // Padrão global: mesma rota, escopo global. Vale para toda categoria que não
  // tenha escolha própria — trocar aqui troca o app inteiro de uma vez (menos a
  // Trilha, que tem controle por exercício).
  async function salvarGlobal(campo, valor) {
    const chave = `global:${campo}`;
    setSalvando(chave);
    setError('');
    try {
      const payload = { global: true };
      payload[campo === 'avaliador' ? 'evaluator' : 'patient'] = valor === '' ? null : valor;
      setCatalogo(await api.setAiModelGlobal(payload));
    } catch (err) {
      setError(err.message || 'Erro ao salvar o padrão global.');
    } finally {
      setSalvando('');
    }
  }

  if (loading) return <div className="card">Carregando…</div>;

  return (
    <div>
      <div className="page-header">
        <div className="eyebrow">Administração · Modelos de IA</div>
        <h2>
          <Typewriter text="Modelos de " />
          <span className="accent"><Typewriter text="IA" delayStart={420} /></span>
        </h2>
        <p>
          Escolha, por modo do app, qual IA avalia a sessão e qual interpreta o paciente simulado.
          A troca vale na próxima chamada — não precisa reiniciar nada.
        </p>
        <p style={{ fontSize: 13, color: 'var(--muted)' }}>
          O que muda aqui é o MODELO, não a régua: Treinamento, Competitivo, Processo Seletivo,
          Visitante e Avaliar Sessão rodam o avaliador oficial (pipeline v29, um nó por critério),
          qualquer que seja o modelo escolhido. Duelo (avaliação comparativa) e Neuroavaliação
          seguem no avaliador de prompt único, por terem grade própria.
        </p>
      </div>

      {error && <div className="alert error">{error}</div>}

      {/* Avaliação para visitantes — o toggle morava na aba Contas. */}
      <div className="card" style={{ marginBottom: 16, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16, flexWrap: 'wrap' }}>
        <div style={{ maxWidth: 620 }}>
          <div style={{ fontWeight: 600, marginBottom: 4, display: 'flex', alignItems: 'center', gap: 10 }}>
            Avaliação para visitantes
            <Chip tone={visitorEval ? 'ok' : 'neutro'}>{visitorEval ? 'LIGADA' : 'DESLIGADA'}</Chip>
          </div>
          <p style={{ margin: 0, fontSize: 13.5, color: 'var(--ink-soft)', lineHeight: 1.5 }}>
            Quando ligada, visitantes recebem avaliação da IA (da Simulação Livre) ao final da
            sessão — para demonstrações em palestras/eventos. Desligada no dia a dia. O modelo
            que roda essa avaliação é o da categoria <strong>Visitante</strong>, abaixo.
          </p>
          {visitorEvalError && <div className="alert error" style={{ marginTop: 8, marginBottom: 0 }}>{visitorEvalError}</div>}
        </div>
        <button
          className={`btn ${visitorEval ? 'btn-outline' : 'btn-primary'}`}
          onClick={toggleVisitorEval}
          disabled={visitorEvalSaving}
          title={visitorEval ? 'Desligar avaliação para visitantes' : 'Ligar avaliação para visitantes'}
        >
          {visitorEvalSaving ? 'Salvando…' : (visitorEval ? 'Desligar' : 'Ligar')}
        </button>
      </div>

      {/* Padrão global: troca todas as categorias de uma vez. Fica antes da
          lista porque é o controle mais grosso — quem quiser afinar desce. */}
      {catalogo && (
        <div className="card" style={{ marginBottom: 16, borderColor: 'var(--marrs)' }}>
          <div style={{ fontWeight: 600, marginBottom: 4 }}>Padrão do sistema (todas as categorias)</div>
          <p style={{ margin: '0 0 12px', fontSize: 13.5, color: 'var(--ink-soft)', lineHeight: 1.5 }}>
            Vale para <strong>toda categoria que não tenha escolha própria</strong> — assim dá pra trocar o app
            inteiro de uma vez, sem passar de uma em uma. Uma categoria configurada abaixo continua com o modelo
            dela; para devolvê-la a este padrão, escolha "Seguir o padrão" no seletor dela. A Trilha fica de fora
            (escolha por exercício).
          </p>
          <div style={{ display: 'flex', gap: 24, flexWrap: 'wrap' }}>
            <div style={{ minWidth: 260, flex: '1 1 280px' }}>
              <label style={{ fontSize: 13, fontWeight: 600, margin: 0, display: 'block', marginBottom: 4 }}>Avaliador</label>
              <select
                value={catalogo.padraoGlobal.evaluator}
                onChange={(e) => salvarGlobal('avaliador', e.target.value)}
                disabled={salvando === 'global:avaliador'}
                style={{ width: 'auto', fontSize: 13, minWidth: 190 }}
              >
                <option value="">Padrão de cada modo (env/código)</option>
                {catalogo.avaliadorOpcoes.map((o) => <option key={o.key} value={o.key}>{o.label}</option>)}
              </select>
              {salvando === 'global:avaliador' && <span style={{ fontSize: 12, color: 'var(--ink-soft)', marginLeft: 8 }}>Salvando…</span>}
            </div>
            <div style={{ minWidth: 260, flex: '1 1 280px' }}>
              <label style={{ fontSize: 13, fontWeight: 600, margin: 0, display: 'block', marginBottom: 4 }}>Paciente simulado</label>
              <select
                value={catalogo.padraoGlobal.patient}
                onChange={(e) => salvarGlobal('paciente', e.target.value)}
                disabled={salvando === 'global:paciente'}
                style={{ width: 'auto', fontSize: 13, minWidth: 190 }}
              >
                <option value="">Padrão de cada modo (env/código)</option>
                {catalogo.pacienteOpcoes.map((o) => <option key={o.key} value={o.key}>{o.label}</option>)}
              </select>
              {salvando === 'global:paciente' && <span style={{ fontSize: 12, color: 'var(--ink-soft)', marginLeft: 8 }}>Salvando…</span>}
            </div>
          </div>
          <div style={{ fontSize: 12.5, color: 'var(--ink-soft)', marginTop: 10, lineHeight: 1.5 }}>
            Seguindo este padrão agora:{' '}
            <strong>
              {catalogo.categorias.filter((c) => c.avaliador.fonte !== 'admin').length} de {catalogo.categorias.length}
            </strong>{' '}
            categorias no avaliador ·{' '}
            <strong>
              {catalogo.categorias.filter((c) => c.temPaciente && c.paciente.fonte !== 'admin').length} de{' '}
              {catalogo.categorias.filter((c) => c.temPaciente).length}
            </strong>{' '}
            no paciente.
          </div>
        </div>
      )}

      {catalogo && catalogo.categorias.map((cat) => (
        <div className="card" key={cat.key} style={{ marginBottom: 16 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginBottom: 4 }}>
            <div style={{ fontWeight: 600 }}>{cat.label}</div>
            {cat.batchCapable ? (
              cat.avaliador.batch
                ? <Chip tone="info" title="Avaliação enfileirada na Batch API da OpenAI: 50% mais barata, janela de até 24h.">BATCH · 50% off</Chip>
                : <Chip title="O provedor deste modelo não expõe Batch API, então a avaliação roda síncrona em background — mais rápida, sem o desconto.">SEM BATCH · síncrono</Chip>
            ) : (
              <Chip title="Nesta categoria a nota volta na mesma requisição, então batch está fora por construção — qualquer modelo aqui roda a preço cheio.">SEMPRE SÍNCRONO</Chip>
            )}
          </div>
          <p style={{ margin: '0 0 12px', fontSize: 13.5, color: 'var(--ink-soft)', lineHeight: 1.5 }}>
            {cat.descricao}
          </p>
          {/* Aviso de custo: GPT numa categoria que não comporta batch paga o
              preço cheio. Importa sobretudo no Treinamento, que é o maior volume. */}
          {!cat.batchCapable && cat.avaliador.provider === 'openai' && (
            <p style={{ margin: '0 0 12px', fontSize: 12.5, lineHeight: 1.5, color: 'var(--ink-soft)' }}>
              ⚠️ Como esta categoria não comporta batch, este modelo GPT roda a{' '}
              <strong>preço cheio</strong>, sem o desconto de 50%.
            </p>
          )}
          <div style={{ display: 'flex', gap: 24, flexWrap: 'wrap' }}>
            <EscolhaModelo
              titulo="Avaliador"
              ajuda="Quem corrige a sessão e dá as notas."
              spec={cat.avaliador}
              opcoes={catalogo.avaliadorOpcoes}
              valor={cat.avaliador.fonte === 'admin' ? cat.avaliador.preset : ''}
              onChange={(v) => salvar(cat.key, 'avaliador', v)}
              salvando={salvando === `${cat.key}:avaliador`}
              padraoLabel={catalogo.padraoGlobal.evaluatorLabel
                ? `Seguir o padrão (${catalogo.padraoGlobal.evaluatorLabel})`
                : 'Seguir o padrão do sistema'}
            />
            {cat.temPaciente && (
              <EscolhaModelo
                titulo="Paciente simulado"
                ajuda="Quem interpreta o personagem na conversa."
                spec={cat.paciente}
                opcoes={catalogo.pacienteOpcoes}
                valor={cat.paciente.fonte === 'admin' ? cat.paciente.preset : ''}
                onChange={(v) => salvar(cat.key, 'paciente', v)}
                salvando={salvando === `${cat.key}:paciente`}
                padraoLabel={catalogo.padraoGlobal.patientLabel
                  ? `Seguir o padrão (${catalogo.padraoGlobal.patientLabel})`
                  : 'Seguir o padrão do sistema'}
              />
            )}
          </div>
        </div>
      ))}

      {/* A Trilha tem controle próprio — deixar isso explícito evita procurar
          aqui a configuração que está no editor de exercícios. */}
      <div className="card" style={{ marginBottom: 16, borderStyle: 'dashed' }}>
        <div style={{ fontWeight: 600, marginBottom: 4 }}>Trilha (exercícios)</div>
        <p style={{ margin: 0, fontSize: 13.5, color: 'var(--ink-soft)', lineHeight: 1.5 }}>
          A Trilha não entra nesta tela: lá o avaliador e o personagem são escolhidos
          <strong> por exercício</strong>, em <em>Exercícios da Trilha</em>. Nada configurado aqui
          altera a Trilha.
        </p>
      </div>

      <div className="card" style={{ background: 'transparent' }}>
        <div style={{ fontWeight: 600, marginBottom: 6 }}>Como isso funciona</div>
        <ul style={{ margin: 0, paddingLeft: 18, fontSize: 13, color: 'var(--ink-soft)', lineHeight: 1.7 }}>
          <li>
            <strong>Caching</strong> está sempre ligado: é automático no prefixo (system + histórico),
            em todos os provedores das opções. Não há nada para configurar.
          </li>
          <li>
            <strong>Batch</strong> entra sempre que a categoria permite — ou seja, onde ninguém está
            esperando a nota na tela (Competitivo e Processo Seletivo). Nos outros modos a nota volta
            na mesma requisição, então batch está fora por construção.
          </li>
          <li>
            <strong>GLM 5.2</strong> pode ser escolhido em qualquer categoria, mas a z.ai não expõe
            Batch API: nas categorias de batch a avaliação passa a rodar síncrona em background
            (chega antes, sem o desconto de 50%).
          </li>
          <li>
            Categoria sem escolha usa o <strong>padrão do sistema</strong> (as variáveis de ambiente
            de sempre), com o modelo e o effort que já rodavam.
          </li>
        </ul>
      </div>
    </div>
  );
}
