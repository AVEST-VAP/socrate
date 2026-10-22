---
name: verify-socrate
description: Drive the Socrate demo (Vite host plus the Worker under Miniflare with local D1 and R2) like a reviewer and prove a behaviour with artefacts. Use it to verify a change of Socrate, reproduce a user path, or collect evidence after a change.
---

# Verify Socrate

Main surface: the demo web app (`apps/demo`, port 5174 for verification) with the Socrate client in its iframes. Secondary surfaces: the Worker HTTP API (port 8788) for CI imports and agent reads, and the repository's test suites. Run every command from the repository root. `SOCRATE_VERIFY_SERVICE_PORT` and `SOCRATE_VERIFY_DEMO_PORT` change both ports when the defaults are taken.

Once: export the variables of [CONTRIBUTING.md](../../../CONTRIBUTING.md), run `npm ci`, then `npx playwright install chromium`. The verification browser never uses a personal profile. The helpers go through `tools/local/local-run.ts`, which validates paths, keeps temporary files and caches inside the clone, and allows only loopback traffic to owned ports.

## Commands

```sh
node .agents/skills/verify-socrate/verify.ts launch
node .agents/skills/verify-socrate/verify.ts doctor
node .agents/skills/verify-socrate/verify.ts drive commentaire-global
node .agents/skills/verify-socrate/verify.ts drive reprise-envoi
node .agents/skills/verify-socrate/verify.ts source
node .agents/skills/verify-socrate/verify.ts cleanup
```

- **launch** starts `tools/local/demo.ts` as a child, instance `verify`, empty storage. It takes the lock `.local/runtime/verify.lock.db`, publishes `.local/runtime/verify.owner.json` (generation, resource phases, storage identity, nonce-authenticated stop control), builds the Worker bundle, applies migrations, writes technical tokens under `.local/runtime/verify/credentials/` (mode 0600), imports `apps/demo/.socrate/` as deployment `local-1`, then starts the host. It prints `launch ok` once the record is `ready` and `doctor` is healthy, then detaches. On timeout (90 s) the child gets an ordinary stop request and the command reports `launch_timeout` only if every recorded resource is `closed`, otherwise `launch_unconfirmed` with the root kept. Launcher log: `.local/artifacts/launch.log`.
- **doctor** is read-only. Exit 1 as soon as one check fails: record `ready`, lock held by a live owner, `GET /v1/health` with the instance id and the exact migration list, same build digest in Worker, record and bundle, host `GET /api/preview-context` with the same instance, service on `127.0.0.1`, storage present, physically the one of the launch and non-empty. A symbolic link on the bundle or in the storage is refused without being followed.
- **drive commentaire-global** signs in, publishes a general comment, reloads, finds it again, then reads it back through the agent API. **drive reprise-envoi** loses the response of a publication the Worker committed, checks the pending line marked as possibly already published, retries with the same key, and proves a single thread.
- **source** prints the source state: `sha=<HEAD>` for a clean tree, or `sha=<HEAD>-dirty+<digest>` covering paths, modes and bytes of admissible changed files. Secrets (`.env*`, `*.token`, keys), links and non-regular files are refused before reading. Final evidence carries a SHA without suffix.
- **cleanup** asks the owner to stop through its private control, really acquires the lock, rereads the generation, requires every recorded resource `closed`, then deletes `.local/runtime/verify/`. Artefacts are kept. No signal is ever sent to a PID read from disk. After a launcher crash, a resource left in `creating` or `running` makes both `cleanup` and `launch` refuse with a diagnostic; there is no automatic recovery.

## Landmarks in the demo

The UI is in French; names below are exact.

- Host: buttons `Se connecter comme <persona>`, links `Agenda`, `Réglages`, `Vue scindée`, `Activité`, button `Se déconnecter`. Personas: `Claire Morel, relectrice produit`, `Karim Benali, développeur` (can resolve any thread), `Claire Morel explorant le compte du Cabinet Dupont` (impersonation), `Invité sans capacité de participation`.
- Toolbar `[data-socrate="toolbar"]`, shown without any click once signed in: `Commenter un élément` (`data-socrate-action="target"`, shortcut `C`), `Brouillon` when a draft is hidden, `Conversations` (`data-socrate="launcher"`), `Plus d’options` (general comment, propose a correction, hide pins, shortcut toggle, stop sharing) and `Tout fermer et arrêter le partage`. Each button has a `[data-socrate="tip"]` tooltip and no `title`.
- Bubble: iframe `#socrate-bubble`, draft `data-testid="socrate-draft"`, field `Votre commentaire` or `Correction proposée`, button `Envoyer`. Enter sends, Shift+Enter adds a line. Escape or a click outside hides it without sending or losing text.
- Pins: `[data-socrate="pin"]` with `data-threads`; right click, Menu key or Shift+F10 opens `Actions de la conversation`.
- List: iframe `#socrate-frame`, title `Conversations`, filters `Cet écran` / `Toutes les pages` and `Ouvertes` / `Résolues` / `Toutes`, rows `data-testid="socrate-row"`, field `Votre commentaire global`.
- Editorial mode: `?editorial=1` on the demo enables the historical panel (title of the review, zones, markers, wording review), `?editorial=0` disables it. Most `browser-tests.ts` scenarios use it.
- Fixtures: `/activite` has recycled rows, indistinguishable duplicates and twin elements to test pin relocation; `/vue-scindee` has a same-origin iframe of the app and a sandboxed third-party iframe.

## Feature map

| Feature | What to check | Automated coverage |
| --- | --- | --- |
| Comment in place | toolbar, targeting, bubble, pins, list, correction by selection, keyboard and focus, narrow windows | `tools/local/commentaires-tests.ts` |
| General comment | publish, reply, reload, restart, second tab, lost response and retry with the same key, abandon, identity change | `drive commentaire-global`, `drive reprise-envoi`, `browser-tests.ts` |
| Thread states | resolve and reopen by author or developer, `412` on concurrent change, guest without capability | `browser-tests.ts`, `apps/service/test/threads.test.ts` |
| Targeted comment and capture | tab sharing, fresh image without Socrate controls, modal and split view, idempotent D1/R2 publication | `browser-tests.ts` (`capture`, `vue scindée`), `apps/service/test/captures.test.ts` |
| Attachments | images and videos in the three composers, private reads, replay, limits, conversion of long videos | `commentaires-tests.ts` (`pièces jointes`), `apps/service/test/attachments*.test.ts` |
| Identity and origin | invalid assertions, unregistered origins, no host token on the network | `apps/service/test/identity.test.ts`, `browser-tests.ts` |
| Manifest import | technical token, replay, immutability, localized errors | `apps/service/test/import.test.ts`, `packages/contract/test/` |
| Guidance and continuity | zones, markers, revision of origin after redeployment, revoked deployment | `browser-tests.ts` (`zones et repères`, `continuité A puis B`), `apps/service/test/continuity.test.ts` |
| Wording | proposals from the page and from the grouped review, drift after a new revision | `apps/service/test/wordings.test.ts`, `browser-tests.ts` |
| Agent API | pagination, filters, incremental reads, captures, project scope, read-only | `apps/service/test/agent-api.test.ts` (runs `docs/agent-api.md`) |
| Operations | archive, manual purge, freeze, backup, restore, end of work | `apps/service/test/operations.test.ts`, `exploitation-cli.ts`, `npm run parcours-local` |
| Served client | `mount()` from `GET /v1/client`, CORS refused for unregistered origins | `tools/local/mount-tests.ts`, `apps/service/test/client.test.ts` |
| Production exclusion and budget | no Socrate module in the production build, network and idle activity per phase | `npm run measure:demo` |

Targeted runs, with the local variables exported and a free port:

```sh
SOCRATE_COMMENTAIRES_PORT=5299 node --test --test-concurrency=1 --test-timeout=180000 --test-name-pattern='^R26' tools/local/commentaires-tests.ts </dev/null
SOCRATE_BROWSER_TEST_PORT=7699 node --test --test-concurrency=1 --test-name-pattern='vue scindée' tools/local/browser-tests.ts </dev/null
npm run build:worker && node --test --test-concurrency=1 apps/service/test/agent-api.test.ts </dev/null
```

`SOCRATE_BROWSER_HEADED=1 SOCRATE_BROWSER_DPR=2` runs the split-view scenario in a visible browser at the screen's physical scale (a graphical session is required).

## Real paths

```sh
node --import ./.agents/skills/verify-socrate/native-focus-hook.mjs .agents/skills/verify-socrate/parcours-reels.ts [output folder]
```

Starts its own `parcours-reels` instance on the skill ports (never together with `launch`): a lost response survives two ordinary service restarts and is retried under the same key; then two real tabs of a headed Chromium exchange the foreground with trusted `visibilitychange` events. `native-focus-hook.mjs` only removes Playwright's focus emulation.

## Campaign

```sh
sh .agents/skills/verify-socrate/campagne.sh
```

Sets the local variables, writes a new folder `.local/artifacts/campagne/<UTC timestamp>-<short sha>/` (`sha.txt`, `git-status.txt`, environment, one log per step, `steps.tsv`) and propagates failures. Blocking preflight: exactly thirteen `retenu, fermeture à borner` skips, a clean `source`, four free ports. Then typecheck, contract and browser suites, budget measurement, real paths, `launch`, and only if it succeeds `doctor` and both `drive`; `cleanup` always runs after a launch attempt.

## Evidence

Each `drive` writes under `.local/artifacts/<feature>/<timestamp>/`: screenshots before, after and after reload or retry, client text, agent read (`lecture-agent.json`), requests received by the service, requests blocked by the browser factory and attempts received by the proxy sink (expected empty). `.local/artifacts/verify.log` keeps every command, its result and the source state.

Standards: go through the real path (host sign-in, Socrate UI), never insert rows directly; capture the action and the resulting state; confirm the side effect through a second channel (agent API or the instance's D1); never mock the service. An injected fault (lost response, `422`, `403`, held response) sets up a scenario, it does not replace the path. A failing path is reported with its command, `echec.png` and the missing precondition, without weakening the check.
