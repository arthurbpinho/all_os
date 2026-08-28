import HoverTag from './HoverTag';

// Assinatura de um autor na Comunidade: avatar, nome e o selo do papel.
//
// O `kind` vem PRONTO do servidor (server/comunidade.js → authorKind) — o
// cliente nunca deduz o selo a partir do papel, senão a regra de quem é
// "Associação Allos" viveria em dois lugares e sairia de sincronia.
//
// A distinção visual pedida é por anel do avatar, e o fundo do card fica a
// cargo de quem renderiza (classe `kind-*` no container, ver index.css):
//   allos      → anel verde brilhante + fundo levemente verde
//   supervisor → anel laranja brilhante + fundo levemente laranja
//   recruiter  → anel verde brilhante, fundo normal
//   member     → anel verde fosco (é da Allos), fundo normal
//   external   → sem anel, fundo normal

// Iniciais como último recurso: conta sem foto não pode virar um quadrado
// vazio ao lado do nome.
function iniciais(nome) {
  const partes = String(nome || '?').trim().split(/\s+/).filter(Boolean);
  if (!partes.length) return '?';
  if (partes.length === 1) return partes[0].slice(0, 2).toUpperCase();
  return (partes[0][0] + partes[partes.length - 1][0]).toUpperCase();
}

// "agora", "há 3 h", "12/03/2026". Passa para data absoluta depois de uma
// semana, quando "há 9 dias" já não ajuda ninguém a se localizar.
export function tempoRelativo(iso) {
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return '';
  const seg = Math.max(0, Math.round((Date.now() - t) / 1000));
  if (seg < 60) return 'agora';
  const min = Math.round(seg / 60);
  if (min < 60) return `há ${min} min`;
  const h = Math.round(min / 60);
  if (h < 24) return `há ${h} h`;
  const d = Math.round(h / 24);
  if (d < 7) return `há ${d} ${d === 1 ? 'dia' : 'dias'}`;
  return new Date(t).toLocaleDateString('pt-BR');
}

// Logo da Associação quando o admin ainda não subiu uma imagem na aba de
// administração da Comunidade. É a marca do app (all_OS) desenhada em texto —
// melhor que um avatar genérico para o que é comunicação institucional.
function LogoAllos() {
  return (
    <span className="comunidade-logo-allos" aria-hidden="true">
      a<span>_</span>
    </span>
  );
}

export default function CommunityAuthor({ author, createdAt, compact = false }) {
  if (!author) {
    return (
      <div className="comunidade-autor">
        <span className="comunidade-avatar kind-external"><span className="comunidade-avatar-iniciais">?</span></span>
        <div className="comunidade-autor-info">
          <span className="comunidade-autor-nome apagado">Comentário removido</span>
        </div>
      </div>
    );
  }

  const { kind, name, subtitle, photo, roleLabel } = author;
  // A etiqueta cobre o avatar e o nome separadamente, não os dois juntos: um
  // gatilho único que embrulhasse a linha inteira abriria a etiqueta também
  // sobre o selo e o horário, que não têm nada a ver com o papel de ninguém.
  return (
    <div className={`comunidade-autor ${compact ? 'compact' : ''}`}>
      <HoverTag text={roleLabel} className="comunidade-autor-gatilho">
        <span className={`comunidade-avatar kind-${kind}`}>
          {photo
            ? <img src={photo} alt="" />
            : (kind === 'allos'
              ? <LogoAllos />
              : <span className="comunidade-avatar-iniciais">{iniciais(name)}</span>)}
        </span>
      </HoverTag>
      <div className="comunidade-autor-info">
        <HoverTag text={roleLabel} className="comunidade-autor-gatilho" focavel>
          <span className="comunidade-autor-nome">{name}</span>
        </HoverTag>
        {subtitle && <span className={`comunidade-selo selo-${kind}`}>{subtitle}</span>}
        {createdAt && <span className="comunidade-tempo">{tempoRelativo(createdAt)}</span>}
      </div>
    </div>
  );
}
