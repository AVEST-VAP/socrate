#!/bin/sh
# Contrôle du tarball hors workspace : paquet installé dans une app Vite + React 19 neuve sous .tmp/, typage, build de production
# (check-absent doit passer) et build de preview (check-absent doit échouer, CSP complétée, deux marqueurs dans le bundle minifié). Seules les dépendances
# de l'app viennent du registre npm.
set -eu
ROOT=$(cd "$(dirname "$0")/../../.." && pwd)
unset NODE_OPTIONS
export TMPDIR="$ROOT/.tmp/tmp" TMP="$ROOT/.tmp/tmp" TEMP="$ROOT/.tmp/tmp"
export npm_config_cache="$ROOT/.local/npm-cache" NODE_COMPILE_CACHE="$ROOT/.local/node-compile-cache"
mkdir -p "$TMPDIR" "$npm_config_cache" "$NODE_COMPILE_CACHE"
APP=$(mktemp -d "$ROOT/.tmp/consumer-XXXXXX")
SERVICE=https://my-socrate.example.workers.dev
echo "== app: $APP"

(cd "$ROOT" && npm run --silent build -w @meyer0x/socrate >/dev/null && npm pack --silent packages/socrate/pack --pack-destination "$APP" >/dev/null)
TARBALL=$(ls "$APP"/meyer0x-socrate-*.tgz)
echo "== tarball: $(basename "$TARBALL")"
tar -tzf "$TARBALL" | sort
echo "== published package.json"
tar -xOzf "$TARBALL" package/package.json | tee "$APP/published.json"
node -e 'const p = require(process.argv[1]); const bad = ["private", "scripts", "devDependencies"].filter((k) => k in p); if (bad.length || /\.\.\/|@socrate\//.test(JSON.stringify(p))) { console.error("published package.json keeps", bad.join(", ") || "a workspace reference"); process.exit(1); }' "$APP/published.json"

mkdir -p "$APP/src" "$APP/public"
cd "$APP"
git init -q .
cat > package.json <<EOF
{
  "name": "consumer-app",
  "private": true,
  "type": "module",
  "dependencies": { "@meyer0x/socrate": "file:./$(basename "$TARBALL")", "react": "19.3.1", "react-dom": "19.3.1" },
  "devDependencies": { "@types/react": "19.2.0", "@types/react-dom": "19.2.0", "@vitejs/plugin-react": "6.1.2", "typescript": "5.9.3", "vite": "8.3.4" }
}
EOF
cat > socrate.yml <<EOF
service: $SERVICE
project: my-app
previews: https://*.my-app.pages.dev
csp: _headers
EOF
printf "/*\n  X-Frame-Options: DENY\n  Content-Security-Policy: default-src 'self'; img-src 'self' data:\n" > public/_headers
cat > index.html <<'EOF'
<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Consumer app</title></head><body><div id="root"></div><script type="module" src="/src/main.tsx"></script></body></html>
EOF
cat > vite.config.ts <<'EOF'
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { socrate } from '@meyer0x/socrate/vite';

export default defineConfig({ plugins: [react(), socrate()] });
EOF
cat > src/vite-env.d.ts <<'EOF'
/// <reference types="@meyer0x/socrate/vite/client" />
EOF
cat > src/main.tsx <<'EOF'
import { StrictMode, Suspense, lazy } from 'react';
import { createRoot } from 'react-dom/client';

const preview = import.meta.env.SOCRATE;
const SocrateReview = preview ? lazy(() => import('@meyer0x/socrate/react').then((m) => ({ default: m.SocrateReview }))) : null;

async function getIdentityAssertion(signal: AbortSignal): Promise<string> {
  const res = await fetch('/api/socrate/assertion', { method: 'POST', signal });
  return (await res.json()).assertion;
}

function App() {
  return (
    <main>
      <h1>Consumer app</h1>
      {preview && SocrateReview && (
        <Suspense fallback={null}>
          <SocrateReview key="user-1" preview={preview} getIdentityAssertion={getIdentityAssertion} navigation={{ current: () => location.pathname, go: (route) => history.pushState(null, '', route) }} />
        </Suspense>
      )}
    </main>
  );
}

createRoot(document.getElementById('root')!).render(<StrictMode><App /></StrictMode>);
EOF
cat > tsconfig.json <<'EOF'
{
  "compilerOptions": { "target": "ES2022", "module": "ESNext", "moduleResolution": "bundler", "lib": ["ES2022", "DOM"], "jsx": "react-jsx", "strict": true, "noEmit": true, "skipLibCheck": false, "types": [] },
  "include": ["src", "vite.config.ts"]
}
EOF

echo "== npm install"
npm install --silent --no-audit --no-fund </dev/null
echo "== typecheck"
npx tsc -p tsconfig.json
echo "== socrate --version: $(npx socrate --version)"

echo "== production build"
env -u SOCRATE_PREVIEW npx vite build --logLevel warn
ls -R dist
npx socrate check-absent dist
grep -q "$SERVICE" dist/_headers && { echo "production _headers changed"; exit 1; }

echo "== preview build"
SOCRATE_PREVIEW='{"serviceUrl":"'$SERVICE'","projectId":"my-app","reviewKey":"pr-42","deploymentId":"pr-42-0123456789ab-991-1","origin":"https://pr-42.my-app.pages.dev","pullRequest":42,"commit":"0123456789abcdef0123456789abcdef01234567","buildId":"991-1","title":"Consumer check"}' \
  npx vite build --logLevel warn
ls dist/assets
if npx socrate check-absent dist; then echo "check-absent passed on a preview build"; exit 1; fi
cat dist/_headers
test "$(grep Content-Security-Policy dist/_headers)" = "  Content-Security-Policy: default-src 'self'; img-src 'self' data: blob:; connect-src 'self' $SERVICE; media-src 'self' blob:"
grep -q '@meyer0x/socrate/client' dist/assets/*.js
grep -q '@meyer0x/socrate/review' dist/assets/*.js
echo "== consumer check passed: $APP"
