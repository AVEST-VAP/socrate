# 0010. Readable targets and resolutions after a redeployment

Within ADR 0002 and ADR 0006. Usage: [how-it-works.md](../how-it-works.md#targets), [agent-api.md](../agent-api.md).

## Context

Most hosts do not put `data-socrate-id` on their elements, so a target is recorded with a positional selector. Until 0.2.0 such a target was relocated only on the deployment where it was written: after any push, every targeted thread showed "Élément introuvable sur cet écran", which reviewers read as a closed dialog or a bug. A resolution written by an agent showed "Résolu dans e005c6c · déploiement pr-…": the deployment was the one online when the agent wrote, almost always a build without the fix.

## Decision

- **Relocation by text on another deployment.** Without an own editorial id, a target is placed on another deployment only when exactly one element of the page, outside Socrate, has the tag that opens the recorded excerpt, the recorded role, and an own text that starts with the **whole** reference text. The reference is the own text of the recorded excerpt (`html`): its text nodes, whitespace collapsed, case kept, at most 500 characters and at least 12. It is never `text`, which can be a selection or, for an empty element, the parent's text. The candidate's own text is read the same way (text nodes outside the tags the sanitizer drops), so block boundaries and CSS (`text-transform`, hidden children) affect both sides alike. A thread carrying a wording proposal (a target made from a selection) and a target without own text are never relocated by text. The rules for the same deployment and for editorial ids are unchanged.
- **Uniqueness checked again.** A probable position is not kept from one host mutation to the next: it is asked again, so a twin appearing later removes the pin, with or without recorded ancestor context.
- **Hidden elements.** Hidden elements count as candidates, so a hidden twin makes the visible one ambiguous. A unique candidate that is not rendered (`getClientRects()` empty or `checkVisibility()` false) is not used.
- **Bounded cost.** Over 300 elements with the same tag and role, the search gives up. Otherwise the own text is read only on candidates whose `textContent` without whitespace contains the reference without whitespace. The candidate lists and these flattened texts are shared by all threads during one pass and forgotten at the next microtask. On a page of 6,000 `div` with 30 unresolved threads of an older deployment, the work per host mutation went from 89 ms to 11 ms (Chromium headless, Apple silicon).
- **Shown as probable.** Such a pin is dashed and labelled "Position probable"; the list keeps "Voir sur la page" with "position probable".
- **"Voir où c’était".** When nothing qualifies, the list offers the thread's capture, cropped and framed on the recorded rectangle, loaded on demand. The target records an optional `container` (`{ label? }`) when it sits in a `dialog`, `[role=dialog]`, `[role=alertdialog]` or `[aria-modal=true]`; the view then asks to open that window and retry.
- **Readable resolution.** Reads compute `transition.liveSince`: the first non-revoked deployment of the review whose commit matches the resolution commit by prefix in either direction, and `transition.liveState`: `live`, `pending` while no non-revoked deployment was created after the resolution, `unknown` once one was. The panel shows "Corrigé par <agent> · en ligne depuis <time>", "· en attente de la prochaine preview" only when `pending`, and nothing more otherwise: a later build may carry the fix under another commit. The commit is on hover, never the deployment id. `deploymentId` stays in the API.

## Why a unique candidate stays safe

This relaxes "never the first match" only in the direction it was meant to protect. Several matches, or none, still give no pin. A single element with the same tag, the same role and the same whole own text is, on a page of an application, the same element in nearly every real case: a block of a record, a paragraph, a heading. Twelve characters exclude generic labels ("Modifier", "Enregistrer") that repeat. Requiring the whole text, not an opening, means an edited ending ("… Maison Nantes" becoming "… Loft Bordeaux") gives no pin: the capture is shown instead. A selection is excluded because its paragraph is not what the reviewer pointed at, and an empty element because the parent's text would designate the parent or a stranger. Nested elements of the same tag starting with the same text count as two candidates and are refused. The remaining risk, a unique element that is not the original one (the original removed and another element with the same text added), is why the pin is visibly probable and the capture remains one click away.

## Rejected alternatives

- **Positional selector across deployments.** A new build shifts `nth-of-type` positions; the pin would land on a neighbour without any sign of doubt.
- **Fuzzy text similarity.** A score threshold picks a winner among several candidates, which is exactly the first-match behaviour this project refuses.
- **Git ancestry for "en ligne".** The service has no repository access. Comparing commits by prefix is exact for the build that carries the fix; a later build that may contain it under another commit is reported without any live state, never as waiting.

## Consequences

- `targetSchema` gains the optional `container`; `Transition` gains `liveSince` and `liveState`, computed without migration. A 0.2.0 client ignores them. A 0.3.0 client facing an older Worker sees `422` on `target.container` alone and resends the same target without it; without `liveSince` and `liveState` it shows "Corrigé par <agent>" with no live state.
- The panel chunk grows by about 600 bytes gzip (the ceiling `panneauGzip` is raised accordingly); the capture view is a separate chunk.
