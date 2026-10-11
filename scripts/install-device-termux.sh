#!/data/data/com.termux/files/usr/bin/bash
# Run INSIDE Termux on the target Android device while safely parked.
# Prepares a separate Code Bridge checkout and private device identity.
# Does NOT register the database identity, enable the worker or access car APIs.
set -euo pipefail
umask 077

if [[ "${PREFIX:-}" != "/data/data/com.termux/files/usr" ]]; then
  printf '%s\n' 'ABORTADO: este instalador deve rodar dentro do Termux Android.' >&2
  exit 2
fi
if [[ "${HOME:-}" != "/data/data/com.termux/files/home" ]]; then
  printf '%s\n' 'ABORTADO: HOME do Termux nao corresponde ao ambiente esperado.' >&2
  exit 2
fi
if ! command -v pkg >/dev/null; then
  printf '%s\n' 'ABORTADO: gerenciador de pacotes pkg indisponivel.' >&2
  exit 2
fi
if ! command -v node >/dev/null; then pkg install -y nodejs-lts; fi
if ! command -v git >/dev/null; then pkg install -y git; fi

target="$HOME/codebridge-device"
if [[ -e "$target" ]]; then
  if [[ ! -d "$target/.git" ]]; then
    printf '%s\n' 'ABORTADO: diretorio de destino ja existe e nao e checkout Git.' >&2
    exit 3
  fi
  origin="$(git -C "$target" remote get-url origin)"
  if [[ "$origin" != "https://github.com/AmaroPSJunior/codex-bridge-queue.git" ]]; then
    printf '%s\n' 'ABORTADO: repositorio de destino inesperado.' >&2
    exit 3
  fi
  # Never overwrite a possibly modified checkout. Updating requires an
  # explicit reviewed release/commit and clean working tree.
  printf '%s\n' 'Checkout ja existe; nenhuma atualizacao automatica realizada.'
else
  git clone --depth 1 --branch main \
    https://github.com/AmaroPSJunior/codex-bridge-queue.git "$target"
fi
cd "$target"
node scripts/device-readiness.cjs
if compgen -G "$HOME/.config/codex-bridge/device-*.json" >/dev/null; then
  node scripts/device-init.cjs --registration
else
  node scripts/device-init.cjs
fi
printf '%s\n' 'PREPARACAO CONCLUIDA: worker permanece DESATIVADO.'
