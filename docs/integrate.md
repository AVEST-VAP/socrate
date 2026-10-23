# Integrate Socrate into your app

An integration has three pieces: an identity bridge in your backend, the client in preview builds, and a CI step that registers each preview. For an app built with Vite and React 19 and deployed from GitHub Actions, the [`@meyer0x/socrate`](../packages/socrate/README.md) package provides the client and the CI step: you write the identity bridge, a `socrate.yml` and a few lines of wiring. Other apps use the module served by the instance and a plain HTTP call, described after the quick start.

Throughout this guide, `my-app` is the project id, `my-backend` the issuer of your assertions, and `https://*.my-app.pages.dev` the pattern of your preview URLs. The demo app in `apps/demo` implements every piece with fictional data.

## Quick start with the package

```sh
npm install @meyer0x/socrate
```

`socrate.yml`, at the root of the app:

```yaml
service: https://my-socrate.example.workers.dev
project: my-app
previews: https://*.my-app.pages.dev
```

`vite.config.ts`, and the type of `import.meta.env.SOCRATE`:

```ts
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { socrate } from '@meyer0x/socrate/vite';

export default defineConfig({ plugins: [react(), socrate()] });
```

```ts
// src/vite-env.d.ts
/// <reference types="@meyer0x/socrate/vite/client" />
```

The component, behind the build-time flag (`false` in every build except a prepared preview build, so production bundles contain none of it):

```tsx
const preview = import.meta.env.SOCRATE;
const SocrateReview = preview ? lazy(() => import('@meyer0x/socrate/react').then((m) => ({ default: m.SocrateReview }))) : null;

async function getIdentityAssertion(signal: AbortSignal): Promise<string> {
  const res = await fetch('/api/socrate/assertion', { method: 'POST', signal });
  if (!res.ok) throw new Error('identity assertion refused');
  return (await res.json()).assertion;
}

{preview && SocrateReview && user && (
  <Suspense fallback={null}>
    <SocrateReview
      key={`${user.id}:${user.exploring?.account ?? ''}`}
      preview={preview}
      getIdentityAssertion={getIdentityAssertion}
      navigation={{ current: () => location.pathname, go: (route) => navigate(route) }}
    />
  </Suspense>
)}
```

Two steps in the pull request workflow, around your build and deploy steps (`on: pull_request` with the `labeled` and `unlabeled` types, `permissions: pull-requests: read`; if that workflow is a required check, read [Required checks](../packages/socrate/README.md#4-github-actions) first):

```yaml
      - id: socrate
        run: npx socrate preview prepare --origin "https://pr-${{ github.event.pull_request.number }}.my-app.pages.dev"
        env:
          GITHUB_TOKEN: ${{ github.token }}
      - run: npm run build
      # … deploy dist/ so that it is served on that origin …
      - if: steps.socrate.outputs.enabled == 'true'
        run: npx socrate preview register --url "https://pr-${{ github.event.pull_request.number }}.my-app.pages.dev/"
        env:
          SOCRATE_IMPORT_TOKEN: ${{ secrets.SOCRATE_IMPORT_TOKEN }}
```

A pull request gets a Socrate preview when it carries the `socrate` label. Run `npx socrate check-absent dist` after your production build. If your preview headers set a Content-Security-Policy, add `csp: _headers` (or your headers file) to `socrate.yml`, and allow `style-src 'unsafe-inline'`. The backend route `/api/socrate/assertion` is the identity bridge of step 1 below. Every option, the CSP completion and the commands are in the [package README](../packages/socrate/README.md).

## 1. Identity bridge

Add an authenticated route to your backend, for example `POST /api/socrate/assertion`. It checks your own session, then returns `{ "assertion": "<jwt>" }`.

The assertion is a compact JWT signed with **ES256** (ECDSA P-256, SHA-256), valid for at most **60 seconds**. Every claim is checked:

| Claim | Meaning |
| --- | --- |
| `iss` | The issuer configured for the project, e.g. `my-backend`. |
| `aud` | `socrate` (the `audience` of the service configuration). |
| `sub` | Stable id of the real user in your app. The Socrate actor is `iss:sub`. |
| `name` | Display name shown as the author. |
| `iat`, `exp` | Validity window, at most 60 seconds; clock skew tolerance is configurable up to 60 seconds. |
| `jti` | Unique id, consumed once. |
| `projectId`, `reviewKey`, `deploymentId` | Session scope. The deployment must be registered and not revoked. |
| `origin` | Exact origin of the preview, equal to the request `Origin` and to the registered origin of the deployment. |
| `capabilities` | Subset of `thread.participate` and `thread.moderate`. Request `thread.moderate` only for developers. |
| `exploring` | `null`, or `{ account, organisation }` when the user impersonates a customer account. Put the real user in `sub` and `name`, never the impersonated one. |

A minimal Node signer is `tools/local/assertion.ts` (`signAssertion`). The demo's fake backend is the Vite plugin in `apps/demo/vite.config.ts`. Generate the key pair once:

```sh
node --input-type=module -e "const k = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']); console.log(JSON.stringify({ private: await crypto.subtle.exportKey('jwk', k.privateKey), public: await crypto.subtle.exportKey('jwk', k.publicKey) }))"
```

The private JWK stays in your backend's secret store. The public JWK goes in the service configuration.

Refusals: a replayed assertion gets `401 assertion_replayed`; a malformed one `401 assertion_invalid`. When a response is lost, the client asks your backend for a new assertion; it never reuses one.

## 2. The client, in preview builds only

The client takes three inputs:

- `preview`: `{ serviceUrl, projectId, reviewKey, deploymentId }`, injected at build time or served by your backend;
- `getIdentityAssertion(signal)`: calls your route from step 1 and returns the JWT string; `signal` is aborted when the client unmounts;
- `navigation`: `{ current(): string, go(route: string): void }`, wired to your router. Socrate uses it to know which screen a comment belongs to and to open the page of a thread.

With React 19, render `SocrateReview` from `@meyer0x/socrate/react` as in the quick start. Its `preview` prop also takes the `origin` of the build: on any other origin, or inside an iframe, the component renders nothing. The `key` remounts the client when the user or the impersonated account changes in the same tab.

### Without npm: the module served by your instance

Your Socrate Worker serves a self-contained build of the client, React included. `GET /v1/client` returns `{ "url": "https://<worker>/client/<hash>.js" }`. Read it once per preview build (or at runtime) and import it:

```js
const { url } = await (await fetch(`${SOCRATE_URL}/v1/client`)).json();
const { mount } = await import(/* @vite-ignore */ url);
const unmount = mount(document.getElementById('socrate'), {
  preview: { serviceUrl: SOCRATE_URL, projectId: 'my-app', reviewKey: 'pr-42', deploymentId: 'pr-42-build-7' },
  getIdentityAssertion: async (signal) => (await (await fetch('/api/socrate/assertion', { method: 'POST', signal })).json()).assertion,
  navigation: { current: () => location.pathname, go: (route) => history.pushState(null, '', route) },
});
```

The client files are immutable and served with `Access-Control-Allow-Origin` only to registered, non-revoked deployment origins: a page from another origin cannot import them. When the signed-in user changes without a page reload, call `unmount()` and `mount()` again. `tools/local/fixtures/mount-host.ts` is a host page without React that does exactly this.

### Keep it out of production

Socrate must only ship in preview builds. With the package, everything behind `import.meta.env.SOCRATE` disappears from production bundles, and `npx socrate check-absent dist` fails if the client code or the service address is still there. Without the package, use your own build-time flag: the demo reads `SOCRATE_PREVIEW_BUILD` and exposes it as `__SOCRATE_PREVIEW__`, and `npm run measure:demo` checks the module graph of its production build.

### Optional attributes

- `data-socrate-id="<id>"` on an element lets the manifest point zones and markers at it.
- `data-socrate-wording="<wording-id>"` on the element that displays exactly one prepared wording attaches proposals made on it to that wording. Never put it on a container that displays several texts.

Keep them behind the same flag (`{...(import.meta.env.SOCRATE && { 'data-socrate-id': 'settings' })}`) so that production markup does not carry them.

## 3. CI

Configure the project in the service (see [self-host-cloudflare.md](self-host-cloudflare.md)), then issue two technical tokens, each limited to the project:

- **`deployment.import`**, stored as a CI secret (`SOCRATE_IMPORT_TOKEN` below). For each preview deployment, CI registers the deployment with its manifest.
- **`review.archive`**, kept out of CI: `POST /v1/projects/my-app/reviews/pr-42/archive` when the work is done. See [operations.md](operations.md).

With the package, the two steps of the quick start do it: `socrate preview prepare` before the build, `socrate preview register` after the deployment. The manifest is the `.socrate/` folder named by `manifest` in `socrate.yml` when the pull request has one, otherwise a generic one built from the pull request title and the `zones` of `socrate.yml`.

### Without the package

The CI job uses a clone of this repository (`npm ci` once) in `$SOCRATE_DIR`. From the root of your app's checkout, with `jq` and `curl`:

```sh
npm --prefix "$SOCRATE_DIR" run --silent assemble -- .socrate > manifest.json
REVIEW=$(jq -r .reviewKey manifest.json)
jq -n --arg commit "$COMMIT_SHA" --arg buildId "$BUILD_ID" --arg url "$PREVIEW_URL" --slurpfile manifest manifest.json \
  '{ commit: $commit, buildId: $buildId, url: $url, manifest: $manifest[0] }' > deployment.json
curl -q -sS --fail-with-body -X PUT -H @- -H 'Content-Type: application/json' \
  "$SOCRATE_URL/v1/projects/my-app/reviews/$REVIEW/deployments/$REVIEW-build-$BUILD_ID" \
  --data @deployment.json <<EOF
Authorization: Bearer $SOCRATE_IMPORT_TOKEN
EOF
```

`npm run --silent assemble -- <dir>` resolves a relative `<dir>` from the directory it is called from, writes the manifest to standard output and nothing else, and on a refusal exits with code 1, printing each faulty file and data path to standard error. `COMMIT_SHA` is the hexadecimal commit (7 to 64 characters), `BUILD_ID` the id of the build (at most 64 characters), `PREVIEW_URL` the URL of the preview, inside `allowedOrigin`. The review in the route must be the `reviewKey` of the manifest, otherwise `422 invalid_manifest`. The import is idempotent: replaying the same body converges, and the same deployment id with a different body is refused with `409 immutable_deployment`. An URL outside `allowedOrigin` is refused with `403`.

`POST …/deployments/{id}/revoke` with the import token revokes a preview: reviewer sessions end, data stays readable.

## Try Socrate against your own app locally

Before deploying anything, you can run the service on your machine and point your app's dev server at it. From a clone of this repository (installed as in the README's "Try it locally"), with your app served on `http://127.0.0.1:5173` and its `.socrate/` folder at hand:

```sh
npm --prefix "$SOCRATE_DIR" run serve -- --origin http://127.0.0.1:5173 --manifest .socrate
```

`npm run serve` starts the real Worker under Miniflare, with local D1 and R2, on `http://127.0.0.1:8787`. On the first run it generates the issuer's ES256 key pair; later runs reuse it with the same storage. It configures one project whose `allowedOrigin` is the given origin and registers a deployment of your manifest for it. A relative `--manifest` is resolved from the directory you call it from; it can be a `.socrate/` folder or an assembled manifest file.

| Option | Default | Meaning |
| --- | --- | --- |
| `--origin` | required | Exact origin of your app, without path. |
| `--manifest` | required | `.socrate/` folder or manifest JSON file. |
| `--port` | `8787` (`SOCRATE_SERVICE_PORT`) | Port of the service; `0` takes a free one. |
| `--project`, `--issuer` | `local`, `local-backend` | Project id and assertion issuer. |
| `--state` | `.local/runtime/serve` of the clone | Storage, keys and host file. It must stay inside the clone; a relative path is resolved from the directory you call it from. |
| `--deployment`, `--commit` | derived from the origin, the commit and the manifest; `0000000` | Deployment id and commit recorded with it. Leave `--deployment` unset: the same id with another origin or manifest is refused with `409 immutable_deployment`. |

When the service is ready, it writes `<state>/host.json` (mode `0600`) and prints one JSON line on standard output, `{"event":"ready","hostConfig":"<path of host.json>","serviceUrl":"…"}`; logs go to standard error. `host.json` holds everything your app needs:

```json
{
  "serviceUrl": "http://127.0.0.1:8787",
  "instanceId": "…",
  "projectId": "local",
  "reviewKey": "my-app-pr-42",
  "deploymentId": "local-3f2a9c41d0be",
  "issuer": "local-backend",
  "audience": "socrate",
  "origin": "http://127.0.0.1:5173",
  "privateKeyPath": "/…/.local/runtime/serve/keys/issuer-private.jwk.json"
}
```

Give `serviceUrl`, `projectId`, `reviewKey` and `deploymentId` to the client as `preview`, and let your local backend sign assertions (step 1) with the private JWK at `privateKeyPath`, using `issuer`, `audience` and `origin` from the same file. This key is a local test key: never reuse it for a deployed instance. Only that origin gets sessions, so serve your app on exactly the same scheme, host and port.

Ctrl+C or `SIGTERM` stops the service and deletes `host.json`; the command exits with code `0` once the closure is confirmed. A host launcher that runs the whole stack waits for the ready line, reads `host.json`, and sends `SIGTERM` when it stops. The command refuses to start if another one owns the same `--state`, if the port is taken, or if the previous run did not confirm its closure (a crash or `SIGKILL`). In that last case, check that no service of that state is still running, then delete `<state>.owner.json` as the message says.

## The `.socrate/` manifest

Every import carries a manifest, which explains the review to reviewers. It is required: an import without it, or without a title, a before/now summary and at least one zone, is refused with `422 invalid_manifest`. The smallest valid folder has two files.

<!-- manifest: .socrate/index.json -->
```json
{
  "schemaVersion": 1,
  "reviewKey": "my-app-pr-42",
  "title": "Automatic appointment reminders",
  "before": "Reminders were sent by hand the day before.",
  "now": "Each office sets its reminder delay.",
  "zones": ["zones/settings.json"]
}
```

<!-- manifest: .socrate/zones/settings.json -->
```json
{
  "id": "reminder-settings",
  "title": "Reminder settings",
  "route": "/settings/reminders"
}
```

`tools/local/test/assemble.test.ts` assembles this exact example and checks that each of `title`, `before`, `now` and `zones` is required.

Optional fields of `index.json`: `repository` (for example `my-org/my-app`), `pullRequest` (a positive number) and `wordings` (the path of a wordings file). A zone file (`zones/*.json`) has a required `id`, `title` and `route`, then optional `instructions`, `questions`, `target` (`{ "id": "<data-socrate-id>" }`), an indicative `source` and `markers` (`{ "kind": "new" | "changed" | "review", "target": { "id": "…" }, "explanation": "…" }`). The wordings file is an array of at most 100 prepared texts: `id`, optional `key` (translation key), `locale`, optional `variant`, `source` (with interpolations), optional `examples`, `question`, optional `zone` and `context`. An empty selection of wordings is normal.

The assembler refuses missing or unreferenced files, unknown fields, path traversal, symbolic links leaving the folder, remote references and executable code, and reports errors with the file and the data path. The schemas are in `packages/contract/src/manifest.ts`; `apps/demo/.socrate/` is a complete example.

When preparing wordings, select only the texts that deserve a human product decision: a functional promise, a business term, a consequence that is irreversible or visible to a third party, or an ambiguity. Socrate never inventories the app's texts. Removing `.socrate/` at the end of the work erases nothing: imported revisions stay readable through `GET …/revisions/{revisionId}`.

The editorial surfaces that display zones, markers and the grouped wording review are hidden by default in the current UI and can be enabled with the `editorial` prop. Comments, pins, conversations and wording proposals from the page work without them.

## Origin policy

Each project of a deployed instance must declare `allowedOrigin`, either an exact origin (`https://preview.example.com`) or a single-label wildcard (`https://*.my-app-previews.pages.dev`). The wildcard stands for exactly one DNS label; scheme and port must be those of the pattern: `https://a.my-app-previews.pages.dev` matches, `https://a.b.my-app-previews.pages.dev`, `http://…`, `…:8443` and `…pages.dev.evil.com` do not. A deployment URL outside the pattern is refused at import, so no session, CORS header or client module can ever be obtained for it. `npm run distant -- preparer` refuses a project without `allowedOrigin`.
