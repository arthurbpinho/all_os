#!/usr/bin/env bash
# Leva as fotos do volume antigo (cópia local) para o volume do app novo, pela
# SSH do Railway. Parte da migração delta (demandas.md §26).
#
# Copia só o que é NOVO ou DIFERENTE (por sha256). Nunca apaga nada no destino.
# Antes de sobrescrever, guarda os arquivos que serão trocados num .tar.gz em
# ~/allos-backups/. Sem --aplicar, só mostra o que faria.
#
# Uso:
#   scripts/sincronizar-fotos-delta.sh <pasta data local> <destino ssh> [--aplicar]
#
# <destino ssh> é um Host do ~/.ssh/config (ou de SSH_CONFIG). O bloco sai de:
#   railway ssh config --alias allos-novo [--path arquivo]
# Opções extras do ssh vão em SSH_OPTS (ex.: -F arquivo -o UserKnownHostsFile=…).
# O <destino> também dá nome ao arquivo de backup.
#
# PASTAS troca as pastas comparadas (padrão: as de fotos). LISTA aponta para um
# arquivo com os caminhos (relativos à pasta data) que podem ir — os demais da
# origem ficam de fora. É assim que vai o detalhe por critério das avaliações:
#   PASTAS=avaliacoes-criterios LISTA=<arquivo com os 91 caminhos> …
set -euo pipefail

ORIGEM="${1:?pasta data local}"
DESTINO="${2:?destino ssh (Host do ssh config)}"
APLICAR="${3:-}"
# shellcheck disable=SC2206
PASTAS=(${PASTAS:-patient-photos exercise-photos avatar-pool})
# SSH_CMD substitui o comando inteiro (o teste usa `docker exec -i <container>`).
# shellcheck disable=SC2206
if [ -n "${SSH_CMD:-}" ]; then SSH=(${SSH_CMD}); else SSH=(ssh -o BatchMode=yes ${SSH_OPTS:-} "$DESTINO"); fi
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

hashes_locais() {
  if [ -n "${LISTA:-}" ]; then
    (cd "$ORIGEM" && tr '\n' '\0' < "$LISTA" | xargs -0 -r sha256sum | sort -k2)
  else
    (cd "$ORIGEM" && find "${PASTAS[@]}" -type f -print0 2>/dev/null | xargs -0 -r sha256sum | sort -k2)
  fi
}
hashes_remotos() { "${SSH[@]}" "cd /data && find ${PASTAS[*]} -type f -print0 2>/dev/null | xargs -0 -r sha256sum | sort -k2" ; }

hashes_locais > "$TMP/local"
hashes_remotos > "$TMP/remoto"

# Nome → hash, dos dois lados.
awk '{print $2, $1}' "$TMP/local" | sort > "$TMP/l"
awk '{print $2, $1}' "$TMP/remoto" | sort > "$TMP/r"
join -a1 "$TMP/l" "$TMP/r" | awk 'NF == 2 {print $1 > "'"$TMP"'/novos"} NF == 3 && $2 != $3 {print $1 > "'"$TMP"'/trocados"}'
touch "$TMP/novos" "$TMP/trocados"
SO_NO_DESTINO=$(join -v2 "$TMP/l" "$TMP/r" | wc -l)

echo "Origem:  $ORIGEM ($(wc -l < "$TMP/l") arquivos)"
echo "Destino: $DESTINO:/data ($(wc -l < "$TMP/r") arquivos; $SO_NO_DESTINO só lá — ficam)"
echo "Novos ($(wc -l < "$TMP/novos")):";       sed 's/^/  + /' "$TMP/novos"
echo "Trocados ($(wc -l < "$TMP/trocados")):"; sed 's/^/  ≠ /' "$TMP/trocados"

cat "$TMP/novos" "$TMP/trocados" > "$TMP/copiar"
if [ ! -s "$TMP/copiar" ]; then echo "Nada a copiar."; exit 0; fi
if [ "$APLICAR" != "--aplicar" ]; then echo; echo "SIMULAÇÃO: nada foi copiado. Rode com --aplicar para copiar."; exit 0; fi

CARIMBO="$(date -u +%Y-%m-%dT%H-%M-%SZ)"
if [ -s "$TMP/trocados" ]; then
  install -d -m 700 "$HOME/allos-backups"
  BACKUP="$HOME/allos-backups/fotos-substituidas-$DESTINO-$CARIMBO.tar.gz"
  (umask 077; "${SSH[@]}" "cd /data && tar czf - $(tr '\n' ' ' < "$TMP/trocados")" > "$BACKUP")
  echo "Cópia dos que serão trocados: $BACKUP ($(tar tzf "$BACKUP" | wc -l) arquivos)"
fi

(cd "$ORIGEM" && tar czf - -T "$TMP/copiar") | "${SSH[@]}" "tar xzf - -C /data --no-same-owner"

# Confere: tudo o que foi copiado tem de bater com a origem.
hashes_remotos > "$TMP/remoto2"
FALHAS=$(join <(awk '{print $2, $1}' "$TMP/local" | sort) <(awk '{print $2, $1}' "$TMP/remoto2" | sort) \
  | awk 'NR==FNR {c[$1]=1; next} ($1 in c) && $2 != $3' "$TMP/copiar" - | wc -l)
FALTANDO=$(join -v1 <(sort "$TMP/copiar") <(awk '{print $2}' "$TMP/remoto2" | sort) | wc -l)
if [ "$FALHAS" -ne 0 ] || [ "$FALTANDO" -ne 0 ]; then
  echo "ERRO: $FALHAS arquivo(s) com hash diferente e $FALTANDO faltando no destino." >&2
  exit 1
fi
echo "Copiados e conferidos por sha256: $(wc -l < "$TMP/copiar") arquivo(s)."
