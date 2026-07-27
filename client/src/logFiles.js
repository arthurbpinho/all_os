// Utilitários compartilhados para COPIAR e BAIXAR logs de sessão e avaliações.
// Usados pelo componente <LogActions> em todos os lugares que exibem um log
// (pós-sessão da Simulação/Trilha/Neuro, visor de Logs do supervisor/aluno,
// Avaliação Independente). Mantém um único formato de seção de avaliação e a
// mesma lógica de copy/download em todo lugar.

export const EVAL_SECTION_HEADER = '===========================\nAVALIAÇÃO DA IA\n===========================';

// Monta a seção de avaliação (com o cabeçalho padrão) ou string vazia.
export function evalSection(evaluationText) {
  const t = (evaluationText || '').trim();
  return t ? `\n\n${EVAL_SECTION_HEADER}\n\n${t}` : '';
}

// Copia texto pra área de transferência. Usa a Clipboard API quando disponível
// (precisa de HTTPS/localhost) e cai num fallback com textarea + execCommand.
export function copyText(text) {
  if (navigator.clipboard && navigator.clipboard.writeText) {
    return navigator.clipboard.writeText(text);
  }
  return new Promise((resolve, reject) => {
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.focus();
      ta.select();
      const ok = document.execCommand('copy');
      ta.remove();
      ok ? resolve() : reject(new Error('copy falhou'));
    } catch (e) {
      reject(e);
    }
  });
}

// Baixa texto como arquivo (.txt por padrão; passe outro `mime` p/ .csv/.json etc).
export function downloadText(filename, text, mime = 'text/plain;charset=utf-8') {
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

// Monta a lista de itens pro <LogActions> a partir de builders preguiçosos.
// - getLog: () => string  (transcrição) — sempre presente.
// - getEval / getBoth: () => string — passe null/undefined quando NÃO há
//   avaliação; nesse caso só o item "Log" aparece (sem "Avaliação"/"Tudo").
export function makeLogItems({ baseName, getLog, getEval, getBoth }) {
  const date = new Date().toISOString().slice(0, 10);
  const base = (baseName || 'sessao').toString().replace(/\s+/g, '_').slice(0, 60) || 'sessao';
  if (!getEval) {
    return [{ key: 'log', label: 'Log', build: getLog, filename: `log-${base}-${date}.txt` }];
  }
  return [
    { key: 'log', label: 'Log', build: getLog, filename: `log-${base}-${date}.txt` },
    { key: 'eval', label: 'Avaliação', build: getEval, filename: `avaliacao-${base}-${date}.txt` },
    { key: 'both', label: 'Tudo', build: getBoth, filename: `log-avaliacao-${base}-${date}.txt` },
  ];
}
