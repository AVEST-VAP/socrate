# 0014. Own feedback as a derived signal

Within ADR 0011 and ADR 0013. Usage: [how-it-works.md](../how-it-works.md#own-feedback).

## Context

A reviewer leaves feedback, often inside dialogs and drawers, and comes back the next day. The list opened on "Cet écran" and "Ouvertes", so their resolved threads were hidden. It sorted by creation and showed the creation date, it had no filter by author, and "Voir dans la preview" only went to the pathname: a dialog opened by `?modal=…` was lost, and a failed jump left the thread open without saying which window to open.

## Decision

- **"Mes retours" is derived from the threads.** A thread is the person's own when they wrote its first message. The badge counts own open threads whose last message is not theirs, or was written by an agent: the threads waiting for their answer. A resolved thread leaves the count, answered or not. `replyTo` and `ownReplies` in `@socrate/contract`, next to `waitsFor`. No column, no migration, no request.
- **No read state.** The badge falls when the person answers, not when they look. A read marker would need a table per person and thread, a write on every opening, and rules for agents and impersonation, for a signal that grants nothing. A reply that needs no answer stays counted until the person writes in the thread or the thread is resolved.
- **The triage view, not a new surface.** The button opens the triage view on an "own" filter: every page, every state, sorted by last activity (`lastActivity`: the later of `updatedAt` and the last message). "Suivant" is the main action, since reading answers is the task; resolving stays possible and secondary.
- **The full URL is replayed, never a click.** For a target of the main document, "Voir sur la page" navigates to the pathname, query and hash of `target.url` when it has the preview's origin, through the host's `navigation.go`. The final value must be a same-origin absolute path: a protocol-relative `//host/…` is refused. A dialog driven by the URL opens again; one driven by local state does not, and the open thread then says which window to open (`openContainerHint`). Relocation and "Cet écran" still compare pathnames, so a query never splits a page in two.

## Limits

- A resolution from the panel writes no message and records no author: it moves the thread up the list as "Résolu" without a name.
- A dialog opened by a click on local state cannot be reopened. Socrate says which one to open.
- The full URL may carry a one-off query (a tracking parameter, a token). It is replayed as recorded, on the same origin only, as the reviewer saw it.

## Rejected alternatives

- **Replaying the reviewer's clicks.** ADR 0011 already refused it: a click on the host can trigger real actions (save, send, delete), and recording them is a new data collection.
- **Asking the host for a route per dialog.** A change in each integrated application; the URL already carries it when the host drives its dialogs that way.
- **A stored "seen" marker.** See "No read state".
- **Comparing full URLs to locate targets.** A filter or a tab in the query would hide pins of the same page.

## Consequences

No change of service, schema or host contract; `navigation.go` may now receive a query and a hash. The panel chunk grows by the toolbar button and the derivation; the view stays in its own chunk.
