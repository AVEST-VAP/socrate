# Contributing

Thanks for your interest. Issues and pull requests are welcome. For a large change, open an issue first so we can agree on the approach.

## Prerequisites

- Node 22.18 or later (CI uses 25.9) and npm.
- macOS or Linux. The browser suites need Chromium, installed inside the clone by Playwright.

## Local boundary

Every command keeps its files inside the clone:

- `.local/`: npm cache (`.npmrc` sets it from `npm ci` on), Playwright browsers, runtime instances (`.local/runtime/<instance>/`), backups, Vite caches and test artefacts (`.local/artifacts/`);
- `.tmp/`: temporary files and test roots.

Both are ignored by Git. Export these variables once per shell before installing or running anything:

```sh
unset NODE_OPTIONS
export TMPDIR=$PWD/.tmp/tmp TMP=$PWD/.tmp/tmp TEMP=$PWD/.tmp/tmp
export npm_config_cache=$PWD/.local/npm-cache PLAYWRIGHT_BROWSERS_PATH=$PWD/.local/pw-browsers NODE_COMPILE_CACHE=$PWD/.local/node-compile-cache
mkdir -p "$TMPDIR" "$npm_config_cache" "$PLAYWRIGHT_BROWSERS_PATH" "$NODE_COMPILE_CACHE"
npm ci
npx playwright install chromium   # once, for the browser suites
```

All entry points (`demo`, `build:worker`, tests, the verification skill) go through `tools/local/local-run.ts`. It validates paths without following symbolic links, sets the temporary and cache directories under the clone, and installs a Node network guard: only loopback ports owned by the run, no redirects, real deadlines. The Worker under Miniflare cannot reach the network. In browser suites, Chromium only reaches the instance's origins; everything else goes to a loopback sink that answers `403`.

## Checks

```sh
npm run typecheck      # TypeScript on packages, demo, tools and Worker
npm run test:contract  # builds the Worker, then service, contract and tooling suites (node:test)
npm run test:browser   # Chromium headless suites on the real demo
npm run verify         # the three above
npm run measure:demo   # production/preview builds, module graph, network trace per phase, budget
```

`npm run measure:demo` is what CI runs (`.github/workflows/preview-budget.yml`). It fails if Socrate leaks into the production build of the demo or if a size ceiling of `tools/local/demo-budget.json` is exceeded. Raise a ceiling only in a reviewed change of that file.

Default ports, all on `127.0.0.1`, changeable through environment variables when something else listens there:

| Variable | Default | Used by |
| --- | --- | --- |
| `SOCRATE_SERVICE_PORT`, `SOCRATE_DEMO_PORT` | 8787, 5173 | `npm run demo`, `npm run parcours-local`; `SOCRATE_SERVICE_PORT` also for `npm run serve` |
| `SOCRATE_STORAGE_TEST_PORT` | 5389 | `test:contract` |
| `SOCRATE_BROWSER_TEST_PORT` | 5199 | `test:browser` |
| `SOCRATE_COMMENTAIRES_PORT` | 5299 | `test:browser` |
| `SOCRATE_CONTINUITY_PORT_A`, `_B` | 5196, 5197 | `test:browser` |
| `SOCRATE_MOUNT_PORT` | 5417 | `test:browser` |
| `SOCRATE_MEASURE_PORT` | 6779 | `measure:demo` |
| `SOCRATE_VERIFY_SERVICE_PORT`, `SOCRATE_VERIFY_DEMO_PORT` | 8788, 5174 | verification skill |

Browser suites write screenshots and facts under `.local/artifacts/<suite>/<timestamp>/`.

## Skipped tests

Thirteen cases of `tools/local/test/{lock,boundary,stack,lifecycle}.test.ts` are marked `skip` with the reason `retenu, fermeture à borner`. Each acquires a resource (witness process, server, Miniflare) before an assertion or a wait, without a complete and bounded shutdown if that exit fails. They are reported as skipped and do not count as passing. Do not remove a `skip` without first making the cleanup of that case bounded on every exit path. `sh .agents/skills/verify-socrate/campagne.sh` checks that there are exactly thirteen.

## Known failures, not regressions

On a fresh clone, `npm run test:browser`, and therefore `npm run verify`, exits with code 1 because of these cases of `tools/local/browser-tests.ts`. They fail without any change of yours; a change is fine when no other test fails.

| Case | How it fails | Frequency |
| --- | --- | --- |
| `deux 401 concurrents livrés dans l’ordre GET puis mutation, …` | `une seule session renouvelée pour les deux 401`: two concurrent `401` responses renew the reviewer session twice instead of sharing one renewal. | every run |
| `deux 401 concurrents livrés dans l’ordre mutation puis GET, …` | same assertion | every run |
| `guidage retenu puis fermeture et remount d’identité : …` | `sous Karim avant ouverture : aucun repère, contour ni observateur résiduel`: a guidance outline of the previous user is still present after the remount. | most runs |
| `wording : remplacement possédé par le brouillon, révision observée figée …` | `locator.click: Timeout 30000ms exceeded` in the full suite; it usually passes when run alone. | intermittent |

They are not marked `skip` on purpose: the first two may reveal a real defect of session renewal and stay visible until it is fixed. If you fix one, remove it from this table in the same change.

## Code conventions

- TypeScript run directly by Node (type stripping), ES modules, no build step except the Worker bundle and the demo.
- Validate at the boundary with the Zod schemas of `packages/contract`. Keep business rules in the service commands, not in callers.
- Every D1 mutation writes its change-log entry in the same batch, and expresses its own preconditions in each statement.
- The UI, the code messages, the code comments, the CLI verbs and options of `tools/local/` and the test names are in French for now; documentation is in English. Keep new code consistent with its surroundings. Exception: the options of `npm run serve`, its ready line and `host.json` form a public contract for host launchers and stay in English.
- Tests drive the real Worker under Miniflare and the real demo in Chromium. Do not mock the service.
- Architecture decisions live in `docs/adr/`. Add one when you change a contract.

## Pull requests

Keep them focused, describe the user-visible behaviour, and include the commands you ran with their result, naming any failure outside the known failures above. CI (`.github/workflows/preview-budget.yml`) runs `npm run typecheck` and `npm run measure:demo` and must pass; it does not run the test suites, so run `npm run verify` locally.
