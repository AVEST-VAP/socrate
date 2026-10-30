# 0011. Full-screen triage from captures

Within ADR 0003 and ADR 0010. Usage: [how-it-works.md](../how-it-works.md#triage-view).

## Context

In a real review, all 11 open threads sat in a dialog or drawer that was closed when the developer came back. The list could only offer "Voir où c’était", which replaced the list with a cropped capture in a 380 px column: the capture and the conversation were never visible together, and each thread took several clicks. Moreover 7 of those 11 threads recorded `container.label === 'Dialog'`, which names the component and tells nothing.

## Decision

- **A full-window view in Socrate's existing iframe**, in a chunk loaded on demand: queue, whole capture with the target framed, conversation. The list stays mounted behind it, so its filters and the control to give focus back survive.
- **The capture is the working material.** The view shows the whole image by default, because the surroundings explain the target; "Cible" crops around the rectangle. It reuses `Shot` and the conversation component, rights included.
- **A stable queue.** It is computed when opened or filtered; resolving keeps the line in place. New threads join the end.
- **Advance after confirmation.** "Résoudre et suivant" waits for the service, through the same intention as the resolve button. A failure or an uncertain write stays on the thread.
- **Readable container names.** `aria-labelledby`, then `aria-label`, then the first heading, skipping component names. The list of generic labels is applied at capture and again at display, so older threads need no migration.
- **Scope of the keys.** Single-character keys follow the C shortcut setting (WCAG 2.1.4) and never apply while typing. `Échap` is not a character key and stays available: without it the view could only be closed by the pointer or Tab.
- **`WhereView` stays for the editorial panel only**, where it follows a failed "Localiser la cible" inside a long panel. The cropped view with "Réessayer" is gone from the list.

## Limits

- A capture shows the past. It explains what the reviewer saw, and proves nothing about the current state: a fix is verified in the running preview, through "Voir dans la preview".
- Cropping is a display choice, not data protection. The whole image is stored and sent to anyone who may read the review; "Cible" hides nothing.
- Only the view's own controls are reachable by keyboard. The host page stays in the accessibility tree behind the iframe, because Socrate does not modify host elements.

## Rejected alternatives

- **Reopening the dialog automatically.** Socrate does not know how: a route rarely encodes a dialog, and clicking the host's controls could trigger real actions.
- **Replaying the reviewer's clicks.** Same risk, plus a new data collection.
- **A DOM snapshot.** ADR 0003 already refused it: another collection, a rendering dependency, and an HTML reconstruction that is not faithful.
- **Navigating to a dedicated page or asking the host for a route.** It would require a change in each integrated application, and lose the state of the preview.
- **Dropping resolved threads from the queue at once.** The selection would jump and the position would change under the reader's eyes.

## Consequences

No change of contract, Worker or host integration. A label already stored is not rewritten. The panel chunk grows by the entry points only; the view is a separate chunk.
