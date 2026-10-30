# 0013. Mentions as text

Within ADR 0012. Usage: [agent-api.md](../agent-api.md#mentions).

## Context

A developer answering feedback needs to ask a person a question inside a thread. Socrate has no directory of the host and no mail service.

## Decision

- **A mention is `@Prénom Nom` in the message body.** No column, no migration. `mentionsName` and `waitsFor` in `@socrate/contract` read it, like `handoffOf`.
- **Suggestions come from the project's message authors**, through `GET /v1/projects/{project}/people`. Socrate never asks the host for its users, and opening the panel does not make someone listable.
- **The route spans the project**, while a session is limited to its review. A reviewer of one review can read the names of people who wrote on another review of the same project, and nothing else about them. People must be mentionable before they join a review.
- **"Pour moi" is derived in the panel**: an open thread where someone else mentioned the person, who has not written since. A count in the toolbar turns red.

## Limits

- Nobody is told outside the panel: a person sees "Pour moi" when they open a preview.
- A mention follows the display name at the time of writing. A renamed person loses it, and two people with the same name both see it.
- Someone who never wrote on the project cannot be suggested. Typing their name still leaves readable text, and nothing more.

## Rejected alternatives

- **Structured mentions in a `messages.mentions` column.** Exact keys, at the cost of a migration, for a signal that grants nothing.
- **The `sessions` table as a directory.** It would reveal who only opened the panel, and it is not in backups.
- **Email or a webhook to the host.** Sending needs a queue, as the Worker has no cron. A later integration can add it.

## Consequences

A Worker deployment is needed for the route. Without it, suggestions offer `@agent` only and the panel keeps working.
