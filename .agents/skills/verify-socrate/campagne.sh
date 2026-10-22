#!/bin/sh
# Campagne de vérification. Chaque exécution écrit dans un nouveau dossier artifacts/campagne/<horodatage>-<sha>/ et ne réécrit aucune archive.
# Un préflight refusé n'ouvre aucune étape suivante. Un lancement refusé n'ouvre ni doctor ni drive, mais cleanup s'exécute toujours après une tentative de lancement.
# Le code de sortie vaut 1 dès qu'une étape échoue ou n'est pas lancée.
set -u
W=$(cd "$(dirname "$0")/../../.." && pwd -P) || exit 1
cd "$W" || exit 1
export TMPDIR="$W/.tmp/tmp" TMP="$W/.tmp/tmp" TEMP="$W/.tmp/tmp" npm_config_cache="$W/.local/npm-cache" PLAYWRIGHT_BROWSERS_PATH="$W/.local/pw-browsers" NODE_COMPILE_CACHE="$W/.local/node-compile-cache"
export SOCRATE_VERIFY_SERVICE_PORT="${SOCRATE_VERIFY_SERVICE_PORT:-8788}" SOCRATE_VERIFY_DEMO_PORT="${SOCRATE_VERIFY_DEMO_PORT:-5174}" SOCRATE_BROWSER_TEST_PORT="${SOCRATE_BROWSER_TEST_PORT:-5199}" SOCRATE_STORAGE_TEST_PORT="${SOCRATE_STORAGE_TEST_PORT:-5389}"
PORTS="$SOCRATE_VERIFY_SERVICE_PORT $SOCRATE_VERIFY_DEMO_PORT $SOCRATE_BROWSER_TEST_PORT $SOCRATE_STORAGE_TEST_PORT"
mkdir -p "$TMPDIR" "$npm_config_cache" "$PLAYWRIGHT_BROWSERS_PATH" "$NODE_COMPILE_CACHE" || exit 1

REL=".local/artifacts/campagne/$(date -u +%Y-%m-%dT%H-%M-%SZ)-$(git rev-parse --short HEAD)"
OUT="$W/$REL"
mkdir -p "$(dirname "$OUT")" && mkdir "$OUT" || { echo "dossier de campagne $OUT déjà présent ou impossible à créer" >&2; exit 1; }
git rev-parse HEAD > "$OUT/sha.txt"
git status --porcelain=v1 --untracked-files=all > "$OUT/git-status.txt"
env | grep -E '^(TMPDIR|TMP|TEMP|npm_config_cache|PLAYWRIGHT_BROWSERS_PATH|NODE_COMPILE_CACHE|SOCRATE_[A-Z_]+)=' | sort > "$OUT/environnement.txt"
printf 'etape\tcode\tdebut\tfin\n' > "$OUT/steps.tsv"
FAIL=0

step() {
  name=$1; shift
  start=$(date -u +%FT%TZ)
  "$@" > "$OUT/$name.log" 2>&1
  code=$?
  printf '%s\t%s\t%s\t%s\n' "$name" "$code" "$start" "$(date -u +%FT%TZ)" >> "$OUT/steps.tsv"
  echo "$name -> $code"
  [ "$code" -eq 0 ] || FAIL=1
  return "$code"
}

not_run() {
  printf '%s\tnon-lance\t-\t%s\n' "$1" "$2" >> "$OUT/steps.tsv"
  echo "$1 -> non lancé ($2)"
  FAIL=1
}

probe() {
  node -e '
const net = require("node:net");
const ports = process.argv.slice(1);
let left = ports.length, bad = 0;
for (const p of ports) {
  const s = net.connect(Number(p), "127.0.0.1");
  let seen = false;
  const done = (state) => { if (seen) return; seen = true; console.log(p + " " + state); if (state !== "refused") bad = 1; s.destroy(); if (--left === 0) process.exit(bad); };
  s.setTimeout(1000, () => done("muet"));
  s.on("connect", () => done("ouvert"));
  s.on("error", (e) => done(e.code === "ECONNREFUSED" ? "refused" : "erreur " + e.code));
}' "$@"
}

preflight() {
  total=$(cat tools/local/test/*.test.ts | grep -c "retenu, fermeture à borner")
  echo "cas retenus : $total (attendu 13)"
  [ "$total" -eq 13 ] || return 1
  src=$(node .agents/skills/verify-socrate/verify.ts source) || return 1
  echo "source : $src"
  case "$src" in *-dirty+*) echo "arbre modifié hors artefacts : campagne refusée"; return 1 ;; esac
  probe $PORTS
}

LATER="typecheck test-contract test-browser mesure-preview parcours-reels launch doctor drive-commentaire-global drive-reprise-envoi cleanup ports-apres"
if ! step preflight preflight; then
  for s in $LATER; do not_run "$s" "préflight refusé"; done
  echo "campagne $REL : échec"
  exit 1
fi

step typecheck npm run typecheck
step test-contract npm run test:contract
step test-browser npm run test:browser
step mesure-preview npm run measure:demo
step parcours-reels node --import ./.agents/skills/verify-socrate/native-focus-hook.mjs .agents/skills/verify-socrate/parcours-reels.ts "$REL/parcours-reels"
if step launch node .agents/skills/verify-socrate/verify.ts launch; then
  step doctor node .agents/skills/verify-socrate/verify.ts doctor
  step drive-commentaire-global node .agents/skills/verify-socrate/verify.ts drive commentaire-global
  step drive-reprise-envoi node .agents/skills/verify-socrate/verify.ts drive reprise-envoi
else
  for s in doctor drive-commentaire-global drive-reprise-envoi; do not_run "$s" "launch en échec"; done
fi
step cleanup node .agents/skills/verify-socrate/verify.ts cleanup
step ports-apres probe $PORTS

if [ "$FAIL" -eq 0 ]; then echo "campagne $REL : succès"; else echo "campagne $REL : échec"; fi
exit "$FAIL"
