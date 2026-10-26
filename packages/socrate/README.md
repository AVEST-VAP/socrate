# @meyer0x/socrate

Everything a web app needs to host [Socrate](https://github.com/meyer0x/socrate) reviews in its pull request previews: a Vite plugin, the React review component, the CI commands, and the commands your coding agent uses to read and answer the feedback ([For coding agents](#for-coding-agents)). You write one `socrate.yml`, add the plugin, render the component behind a build-time flag, and add two CI steps. Production builds contain no Socrate code.

Requirements: a Socrate service you host ([self-host guide](https://github.com/meyer0x/socrate/blob/main/docs/self-host-cloudflare.md)), Vite, React 19, GitHub Actions, Node 20 or later in CI.

```sh
npm install @meyer0x/socrate
```

## 1. `socrate.yml`

At the root of your app (the plugin and the CLI look for the first `socrate.yml` from the Vite root, or the current directory, up to the Git root):

```yaml
service: https://my-socrate.example.workers.dev   # origin of your Socrate service
project: my-app                                   # project id configured in the service
previews: https://*.my-app.pages.dev              # origins of your previews, as allowedOrigin in the service
```

| Key | Default | Meaning |
| --- | --- | --- |
| `service` | required | https origin of the service, without path or trailing slash. `http` is accepted for `127.0.0.1`, `localhost` and `[::1]` only. |
| `project` | required | Project id in the service configuration: lowercase letters, digits and dashes. |
| `previews` | required | Exact origin or single-label wildcard (`https://*.my-app.pages.dev`), the same syntax and meaning as the project's `allowedOrigin`. |
| `label` | `socrate` | Pull request label that turns Socrate on for a pull request. |
| `review` | `pr-{pr}` | Template of the review key; `{pr}` is the pull request number. |
| `before` | `The app before pull request #{pr}.` | "Before" text of the generic manifest, shown to reviewers; `{pr}` and `{title}` (the pull request title) are replaced. At most 400 characters once rendered. |
| `now` | `Pull request #{pr}: {title}` | "Now" text of the generic manifest, same placeholders. Write both in your reviewers' language. |
| `csp` | none | Headers file of the build output to complete, e.g. `_headers` (relative to Vite's `build.outDir`). |
| `zones` | one zone `/` | Zones of the generic manifest: a list of `{ id, title, route }` (all the zone fields of the [manifest](https://github.com/meyer0x/socrate/blob/main/docs/integrate.md#the-socrate-manifest) are accepted). |
| `manifest` | none | `.socrate/` folder (relative to `socrate.yml`) assembled instead of the generic manifest when the pull request has one. |

An invalid file stops the build or the command with one line per faulty key.

## 2. Vite plugin

```ts
// vite.config.ts
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { socrate } from '@meyer0x/socrate/vite';

export default defineConfig({ plugins: [react(), socrate()] });
```

```ts
// src/vite-env.d.ts
/// <reference types="@meyer0x/socrate/vite/client" />
```

The plugin defines `import.meta.env.SOCRATE`:

- `false` when `SOCRATE_PREVIEW` is not set: every build, dev server included, except a prepared preview build. Code behind the flag is removed from the bundle.
- `{ serviceUrl, projectId, reviewKey, deploymentId, origin }` when `SOCRATE_PREVIEW` is set by `socrate preview prepare`. The value is checked against `socrate.yml` (service, project, origin inside `previews`, review key template, identifiers), and any mismatch fails the build. `vite serve` refuses to start with `SOCRATE_PREVIEW` set; `vite preview` of a finished build is allowed.

When `csp` is set, a preview build completes the single `Content-Security-Policy` line of that file after writing the bundle: the service origin is added to `connect-src`, and `blob:` to `img-src` and `media-src` (the client downloads screenshots and videos from the service, then shows them from `blob:` URLs it creates). A missing directive is created from the sources of `default-src`. A missing file, or zero or several `Content-Security-Policy` lines, fails the build. Production builds leave the file untouched.

The component also needs `style-src 'unsafe-inline'`: it renders its own `<style>` elements and inline styles. The plugin does not add it; if your policy restricts `style-src`, allow it in the preview headers yourself.

`socrate({ config: 'path/to/socrate.yml' })` sets the file explicitly, relative to the Vite root.

## 3. The component

```tsx
import { lazy, Suspense } from 'react';

const preview = import.meta.env.SOCRATE;
const SocrateReview = preview ? lazy(() => import('@meyer0x/socrate/react').then((m) => ({ default: m.SocrateReview }))) : null;

async function getIdentityAssertion(signal: AbortSignal): Promise<string> {
  const res = await fetch('/api/socrate/assertion', { method: 'POST', signal });
  if (!res.ok) throw new Error('identity assertion refused');
  return (await res.json()).assertion;
}

export function Review({ user, navigation }: { user: { id: string } | null; navigation: { current(): string; go(route: string): void } }) {
  if (!preview || !SocrateReview || !user) return null;
  return (
    <Suspense fallback={null}>
      <SocrateReview key={user.id} preview={preview} getIdentityAssertion={getIdentityAssertion} navigation={navigation} />
    </Suspense>
  );
}
```

- `preview`: `import.meta.env.SOCRATE`. The component renders nothing inside an iframe, or when the page origin differs from `preview.origin`.
- `getIdentityAssertion(signal)`: calls the identity bridge of your backend, which returns a 60-second ES256 assertion for the signed-in user. The contract is in [docs/integrate.md](https://github.com/meyer0x/socrate/blob/main/docs/integrate.md#1-identity-bridge). It may be written inline: the component always calls the latest function it received, and a new function does not restart the review client.
- `navigation`: `{ current(), go(route) }`, wired to your router.
- `key`: remount the component when the signed-in user, or the account they impersonate, changes in the same tab.

Keep the condition at module level, as above: with `SOCRATE` at `false`, the dynamic import disappears and no chunk of the package is emitted.

## 4. GitHub Actions

Two steps around your existing build and deploy steps:

```yaml
on:
  pull_request:
    types: [opened, synchronize, reopened, labeled, unlabeled]

permissions:
  contents: read
  pull-requests: read

jobs:
  preview:
    # Adding or removing another label rebuilds nothing.
    if: (github.event.action != 'labeled' && github.event.action != 'unlabeled') || github.event.label.name == 'socrate'
    runs-on: ubuntu-latest
    env:
      # The origin reviewers will open, known before the build: here a Cloudflare Pages branch alias (deploy with --branch pr-<number>).
      PREVIEW_ORIGIN: https://pr-${{ github.event.pull_request.number }}.my-app.pages.dev
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
      - run: npm ci
      - id: socrate
        run: npx socrate preview prepare --origin "$PREVIEW_ORIGIN"
        env:
          GITHUB_TOKEN: ${{ github.token }}
      - run: npm run build        # vite build reads SOCRATE_PREVIEW
      # … deploy dist/ to your preview host …
      - if: steps.socrate.outputs.enabled == 'true'
        run: npx socrate preview register --url "$PREVIEW_ORIGIN/"
        env:
          SOCRATE_IMPORT_TOKEN: ${{ secrets.SOCRATE_IMPORT_TOKEN }}
```

In CI the package is installed as a dependency of your project (`npm ci`), so `npx socrate` runs its local bin. Outside such a project, write `npx @meyer0x/socrate`: the bare name `socrate` on npm belongs to an unrelated package.

`socrate preview prepare --origin <origin>` reads the pull request labels live from the GitHub API (`GITHUB_TOKEN` or `GH_TOKEN`). Outside a `pull_request` event, or without the label, it writes the output `enabled=false` and nothing else: the build is a normal one. Otherwise it checks the origin against `previews`, writes `SOCRATE_PREVIEW` to `GITHUB_ENV` for the next steps, and sets the outputs `enabled=true`, `review` (the review key) and `deployment` (`pr-<number>-<head sha, 12 characters>-<run id>-<run attempt>`). Adding the label triggers a `labeled` run that builds the preview with Socrate; removing it triggers an `unlabeled` run that builds it without. Without `unlabeled`, the preview keeps Socrate until the next push.

**Required checks.** A job skipped by its `if` reports success, and that result becomes the latest one of its check on the head commit. If this job is a required status check, adding an unrelated label to a pull request whose build failed would turn the check green. In that case, keep `labeled` and `unlabeled` out of this workflow and re-run its last run from a small workflow instead. A re-run gets a new run attempt, hence a new deployment, and `prepare` reads the labels again:

```yaml
# .github/workflows/socrate-label.yml
on:
  pull_request:
    types: [labeled, unlabeled]

permissions:
  actions: write

jobs:
  rerun:
    if: github.event.label.name == 'socrate'
    runs-on: ubuntu-latest
    steps:
      - env:
          GH_TOKEN: ${{ github.token }}
          GH_REPO: ${{ github.repository }}
          HEAD_SHA: ${{ github.event.pull_request.head.sha }}
        run: |
          run=$(gh run list --workflow preview.yml --commit "$HEAD_SHA" --event pull_request --limit 1 --json databaseId --jq '.[0].databaseId')
          if [ -n "$run" ]; then gh run rerun "$run"; fi
```

`gh run rerun` refuses a run still in progress: label the pull request after its build has finished, or push again.

`socrate preview register --url <url>` reads `SOCRATE_PREVIEW` and `SOCRATE_IMPORT_TOKEN` (a `deployment.import` token of the project, stored as a CI secret), builds the manifest and registers the deployment with the service. The URL must be on the origin given to `prepare`. The manifest is the `manifest` folder of `socrate.yml` when the checkout has one, with the review key and pull request number of the preview; otherwise a generic manifest: the pull request title (cut to 80 characters), the `before` and `now` texts and the `zones` of `socrate.yml`. A refusal exits with code 1 and prints the HTTP status, the service error code and its message. The token is never printed.

## 5. Check production builds

```sh
npx socrate check-absent dist
```

Fails if a file of `dist` (source maps excluded) contains the client code of this package or the address of `service`. Run it after your production build.

## For coding agents

A coding agent (Claude Code, Codex…) reads the feedback of your pull request and answers it in your name. Connect it once per project and machine:

```sh
npx @meyer0x/socrate login            # inside Claude Code or Codex the agent is detected; otherwise --agent <name>
```

The command prints a code such as `KPXD-4821`. Open a preview of the project where you are signed in, choose **Plus d'options → Connecter un agent** in the Socrate toolbar, enter the code, check the agent and machine, and click **Autoriser**. Only approve a code you just requested. The agent can then, for 30 days, read every review of the project, reply, resolve and reopen threads; it cannot create threads. Its messages show "Your Name · via Claude". Revoke it under **Mes agents** in the panel, or with `npx @meyer0x/socrate logout`.

A typical loop for the agent:

```sh
npx @meyer0x/socrate threads --json                          # open threads of the current branch's pull request
npx @meyer0x/socrate thread <id> --captures .socrate --json  # messages, target (route, text, selector, HTML) and downloaded screenshot
# … fix the code, commit …
npx @meyer0x/socrate reply <id> "Moved the save button out of the modal."
npx @meyer0x/socrate resolve <id> --message "Shortened the reminder label."   # links HEAD; --commit <sha> or --no-commit
```

- `service` and `project` come from `socrate.yml`, found as above, or `--config`.
- The review is `--review <key>`, `--pr <number>` rendered with the `review` template, or by default the pull request of the current branch read with `gh`.
- Tokens are stored in `$XDG_CONFIG_HOME/socrate/credentials.json` (default `~/.config/socrate/`, directory 0700, file 0600), one per service, project and agent, and are never printed. The agent of a command is `--agent`, else the one detected (`CLAUDECODE` for Claude Code, `CODEX_THREAD_ID` or `CODEX_SANDBOX` for Codex), else the only token stored for the project.
- A message given as `-` is read from standard input.
- Each write is one request with an idempotency key, retried with the same key after a lost answer. If the outcome is still unknown after the retries (network, 5xx, lost answer), the command exits with `1` and prints the key: `The reply may have been recorded. Run the command again with --key <key> so as not to duplicate it.` With `--json`, standard output holds `{ "outcome": "uncertain", "idempotencyKey": "<key>", "message": "…" }`. Run the same command with `--key <key>`: the service returns the first result instead of writing twice. Without `--key`, each command is a new write, even with the same message.
- A token the service refuses with `401` (revoked or expired) is removed from the credentials file; run `npx @meyer0x/socrate login` again.
- Readable output replaces control characters coming from the service (bodies, names, target, HTML) with `�`; `--json` keeps them as sent.
- `--json` prints stable JSON, made for agents: the service's thread, message and list objects ([agent API](https://github.com/meyer0x/socrate/blob/main/docs/agent-api.md)).

## Commands

`socrate` is the bin of this package: `npx socrate` inside a project that depends on it, `npx @meyer0x/socrate` anywhere else.

```
socrate preview prepare --origin <origin of the preview> [--config socrate.yml]
socrate preview register --url <deployed preview URL> [--config socrate.yml]
socrate check-absent <build output directory> [--config socrate.yml]
socrate login [--agent <name>] [--config socrate.yml] [--json]
socrate logout [--agent <name>] [--config socrate.yml] [--json]
socrate threads [--pr <n> | --review <key>] [--state open|resolved|all] [--agent <name>] [--json]
socrate thread <id> [--pr <n> | --review <key>] [--captures <dir>] [--agent <name>] [--json]
socrate reply <id> <message | -> [--key <key>] [--pr <n> | --review <key>] [--agent <name>] [--json]
socrate resolve <id> --message <text | -> [--commit <sha> | --no-commit] [--key <key>] [--pr <n> | --review <key>] [--agent <name>] [--json]
socrate reopen <id> --message <text | -> [--key <key>] [--pr <n> | --review <key>] [--agent <name>] [--json]
socrate --version
```

Exit codes: `0` success, `1` refusal by the service (its status, code and message are printed) or failure, `2` usage error (including a missing login or pull request).

## Without Vite, React or GitHub Actions

The service also serves a self-contained client module (`GET /v1/client`, then `mount(element, props)`) for apps without React or without npm, and the deployment import is a plain HTTP `PUT`. See [docs/integrate.md](https://github.com/meyer0x/socrate/blob/main/docs/integrate.md).

## License

MIT
