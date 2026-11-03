# 0015. The control that opened a container

Within ADR 0010, ADR 0011 and ADR 0014. Usage: [how-it-works.md](../how-it-works.md#going-back-to-a-target), [integrate.md](../integrate.md#optional-attributes).

## Context

Reviewers leave most of their feedback inside dialogs and drawers. When they come back, "Voir sur la page" goes to the recorded page, and since 0.5.0 it replays the full URL, which reopens a dialog driven by `?modal=…`. Many hosts open their drawers from local state (a store, a `useState`), not from the URL. The target is then missing and Socrate only says "C’était dans la fenêtre « … ». Ouvrez-la…": the reviewer no longer remembers which button opened that window, and on a dense page there are dozens of candidates.

## Decision

- **Record the opener at capture.** When the target sits in a container (ADR 0010), `target.container.opener` records the control that opened it, outside the container and outside Socrate: the single `[aria-controls~="<container id>"]` (Base UI and Radix set it), the most recently activated of several, otherwise the last activation of the target's document that happened outside the container. An activation is a pointer press, or Enter or Space; its first interactive ancestor (`button`, `a`, `[role=button|tab|menuitem|link]`, `[data-socrate-opener]`) is kept. A capture-phase listener on the tab's document and on each direct same-origin iframe keeps weak references to the last 16 event targets, with no reading of the layout; the sorting happens once, at targeting. During selection the capture's interception stops events before the document, so only gestures that reached the host are kept.
- **Fields.** `role` (required), `name` (simplified accessible name: `aria-labelledby`, `aria-label`, text, `title`; one line, at most 80 UTF-16 units, no control character), `selector` (300 at most), `socrateId` (`data-socrate-id`) and `key` (`data-socrate-opener`, letters, digits, `.`, `_`, `:`, `-`, 128 at most). The same sanitization level as the rest of the target: no HTML, no attribute other than those two.
- **Going back.** When the target is missing and an opener is recorded, Socrate looks for it on the target's document: by `key`, then `socrateId`, then the selector whose element still has the recorded role and name. The match must be unique and rendered.
- **A click only on a declared opener.** If the element found still carries `data-socrate-opener` equal to the recorded `key`, Socrate clicks it, waits for the target (about two seconds of frames), then proceeds as a normal success: scroll and thread bubble. The host promised that this click only opens.
- **Otherwise a mark, never a click.** Socrate scrolls to the control, draws a frame around it that lets clicks through, and says "Ouvrez « <name> » pour retrouver l’élément". When the reviewer activates it and the target appears, the thread bubble opens. The mark goes away with the hint, the next "Voir sur la page", "Tout fermer" or Socrate's unmount, and at the next scroll or resize once the control has left the page.
- **Opener not found.** The window hint of ADR 0014 stays.

## Compatibility

`targetSchema` is a strict object, so a Worker that predates this field answers `422 invalid_request` with an issue at `target.container.opener` (`unrecognized_keys`). Validation runs before any write, so the client resends the same payload without `opener`, under the same idempotency key, and keeps the container and its label; a Worker older than `container` still gets the existing second fallback. A new client therefore never fails against an older Worker, and no deployment order is required. A deployment order alone was rejected: self-hosted instances update the Worker and the preview package independently, and a missed step would block every targeted comment in a dialog. Older threads have no `opener` and behave as before; nothing is migrated.

## Why not

- **A breadcrumb of every click.** Recording the path that led to a dialog is a new collection of the reviewer's navigation, grows with each click, and replaying it would still need clicks.
- **A blind replay of the recorded click.** A host control can save, send or delete. Socrate cannot tell an opener from an action, so it only clicks what the host declared harmless. The selector of another build can also designate a neighbour.
- **An `openTarget` prop.** A host callback that reopens any container from a target would be the most precise, but every integration would have to map Socrate targets to its own state. The attribute covers the common case with one line in the markup; the prop stays possible if a host needs it.

## Limits

- The opener is the last activation outside the container when no `aria-controls` names it. A container opened by a timer, a keyboard shortcut or a route change after an unrelated click may record that unrelated control; it is only marked, never clicked, unless it carries the attribute.
- A container nested in another one records the control that opened the inner one; the outer one must already be open.
- The name is read from the DOM, not computed like a screen reader. A control whose label changes (a counter in the text) is not found by selector and falls back to the window hint.

## Consequences

`targetSchema` gains the optional `container.opener`. The panel chunk grows by the activation listener and the new branch of "Voir sur la page"; finding, clicking and marking the opener are in a chunk loaded only when a target in a container is missing. The ceilings `panneauGzip` and `arriveeOuvertureOctets` are raised accordingly.
