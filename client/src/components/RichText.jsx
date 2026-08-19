import { parseInline } from '../markdownInline';

// Renderiza prosa vinda de IA com a marcação markdown JÁ APLICADA: *itálico*,
// **negrito**, ~~tachado~~ e `código` viram formatação, não asteriscos na tela.
//
// Usado em todo lugar que mostra fala de paciente, avaliação, feedback ou
// transcrição. Os elementos são criados pelo React a partir de tokens — nunca
// dangerouslySetInnerHTML — então nada que o modelo escreva vira markup.
//
// Por que <span class="rt-*"> e não <strong>/<em>: o CSS do app já reaproveita
// esses elementos com outro sentido. No visor de logs, `.log-detail .msg strong`
// é o RÓTULO do autor da fala (bloco, maiúsculas, 11px), e o `em` global troca a
// família tipográfica para a serifada em itálico. Emitir os elementos semânticos
// faria o negrito do paciente virar etiqueta e o itálico trocar de fonte no meio
// da frase. Com classe própria, a formatação do texto do modelo não herda nada.
//
// Espaço em branco e quebras de linha continuam por conta do CSS do container
// (`white-space: pre-wrap`), como antes; este componente não mexe neles. Trecho
// sem marcação nenhuma sai como string pura, sem elemento em volta.
export default function RichText({ text }) {
  const tokens = parseInline(text);
  return (
    <>
      {tokens.map((t, i) => {
        const cls = [
          t.bold && 'rt-b',
          t.italic && 'rt-i',
          t.strike && 'rt-s',
          t.code && 'rt-code',
        ].filter(Boolean).join(' ');
        return cls ? <span key={i} className={cls}>{t.text}</span> : t.text;
      })}
    </>
  );
}
