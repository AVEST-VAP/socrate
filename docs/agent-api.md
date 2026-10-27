# Agent API: read and answer the feedback of a review

This guide is for the coding agent (Claude Code, Codex…) that works on a pull request reviewed with Socrate. The API is JSON and works from a terminal, without a browser. It triggers nothing: no feedback calls an agent, a webhook or a notification. The agent reads when it decides to.

There are two ways in:

- **Delegated login, the main path.** The developer runs `npx @meyer0x/socrate login` once and approves a code in a preview where they are signed in. For 30 days, the agent reads every review of the project, replies to threads, resolves and reopens them **in the developer's name**, shown as "Name · via Claude". The [`socrate` CLI](../packages/socrate/README.md#for-coding-agents) wraps everything below.
- **Read token, for automation without a person.** A `review.read` bearer issued by the operator reads everything and writes nothing. See [Read token](#read-token-for-automation-without-a-person).

Every `sh` block below marked `<!-- example: … -->` is executed verbatim against a real Worker by `apps/service/test/agent-api.test.ts`. The delegated flow is covered by `apps/service/test/agent-login.test.ts` and `packages/socrate/test/agent-cli.test.ts`.

## Delegated login

### With the CLI

```sh
npx @meyer0x/socrate login --agent Claude      # prints a code such as KPXD-4821, waits for approval
```

Run the CLI as `npx @meyer0x/socrate`: the bare name `socrate` on npm belongs to an unrelated package. In a project that lists `@meyer0x/socrate` as a dependency, as in the CI steps of [integrate.md](integrate.md), `npx socrate` runs its local bin.

The developer opens a preview of the project where Socrate is mounted and where they are signed in, chooses **Plus d'options → Connecter un agent** in the Socrate toolbar, enters the code, checks the agent, machine and project shown, and clicks **Autoriser**. The command then stores the token and exits. Then:

```sh
npx @meyer0x/socrate threads                                   # open threads of the pull request of the current branch
npx @meyer0x/socrate thread <id> --captures .socrate-shots     # messages, target, screenshot and attachments
npx @meyer0x/socrate reply <id> "Fixed in the next commit."
npx @meyer0x/socrate resolve <id> --message "Shortened the label."   # commit defaults to HEAD
npx @meyer0x/socrate reopen <id> --message "Regression seen on the preview."
npx @meyer0x/socrate logout
```

`--json` gives a stable JSON output on every command. The CLI reference is in [packages/socrate/README.md](../packages/socrate/README.md#for-coding-agents).

### Device authorization (RFC 8628, adapted)

The CLI follows this protocol; any tool can.

1. **Start**, without authentication and without `Origin` header: `POST /v1/auth/device` with `{ projectId, agent, machine }`. `agent` is 1 to 32 printable characters (`Claude`, `Codex`), `machine` 1 to 64. Answer `201`:

   ```json
   { "deviceCode": "<43 base64url characters>", "userCode": "KPXD-4821", "expiresIn": 600, "interval": 5 }
   ```

   `deviceCode` is 256 random bits, stored as a hash; keep it in the tool. `userCode` is 8 characters from `BCDFGHJKMNPQRSTVWXZ2346789` (no vowel, no `0`, `1`, `5` or `L`), shown as `XXXX-XXXX`; show it to the person. An unknown project gives `404 not_found`; more than 20 pending codes on the project give `429 rate_limited`.
2. **Approval in the panel**, with a reviewer session (exact `Origin`, as every session request):
   - `GET /v1/projects/{project}/devices/{userCode}` returns `{ userCode, projectId, agent, machine, createdAt, expiresAt }`. Case, dash and spaces of the typed code are ignored.
   - `POST /v1/projects/{project}/devices/{userCode}/approve` or `…/deny` returns `{ state: "approved" | "denied" }`.
   - Approval is refused with `403` while the session explores a customer account (`exploring`) or lacks `thread.participate`. An expired code gives `410 expired_token`, or `404 not_found` once the code is erased; an already decided one `409 state_conflict`, a code of another project `404 not_found`.
   - Each lookup reserves an attempt before reading the code, atomically, and a found code releases it: each lookup of an unknown, malformed or other-project code counts as a failure for the signed-in person on the project; after 5 failures in 10 minutes, every lookup answers `429 rate_limited`, whatever the session.
   - Approval freezes the real person (`actor`), the agent and the capabilities: `review.read`, `thread.participate`, and `thread.moderate` when the session has it, intersected with the project's `attestableCapabilities`.
3. **Exchange**, without authentication and without `Origin` header: `POST /v1/auth/device/token` with `{ deviceCode }`, every `interval` seconds.

   | Status | Code | Meaning | Tool |
   |---|---|---|---|
   | 400 | `authorization_pending` | not decided yet | wait `interval`, poll again |
   | 400 | `slow_down` | polled before `interval` | add 5 seconds to `interval` |
   | 400 | `access_denied` | denied in the panel, or the project no longer lets anyone delegate | stop |
   | 400 | `expired_token` | code expired (10 minutes) or unknown | start again |
   | 400 | `invalid_grant` | code already exchanged | start again |
   | 200 | | approved | store the token |

   The `200` answer comes once:

   ```json
   { "accessToken": "<43 base64url characters>", "tokenType": "Bearer", "tokenId": "…", "projectId": "my-app", "agent": "Claude", "machine": "dev-laptop",
     "actor": { "key": "my-backend:42", "displayName": "Karim Benali" }, "capabilities": ["review.read", "thread.participate", "thread.moderate"], "expiresAt": "…" }
   ```

   The token is 256 random bits, stored as a hash, valid 30 days from the exchange, never extended by use.

### The delegated token

- **Scope**: the whole project, every review. It gives every read of this guide, like `review.read`, and the writes below. Nothing else: no thread creation, no wording proposal, no attachment, no archive, no purge, no import (`403 forbidden` with the reason).
- **Tools only**: a request carrying a delegated token **and** an `Origin` header is refused with `403`. The start and the exchange refuse `Origin` too. The token is never meant for a page.
- **Policy at each use**: capabilities are intersected again with the project's `attestableCapabilities` at every request. If `thread.moderate` is removed, the agent can no longer resolve other people's threads; if `thread.participate` is removed, the token gives nothing, reads included.
- **Revocation** takes effect at the next request (`401 unauthenticated`):
  - in the panel, **Connecter un agent → Mes agents** lists the agents of the signed-in person on the project (`GET /v1/projects/{project}/agents`: `{ items: [{ tokenId, agent, machine, capabilities, createdAt, lastUsedAt, expiresAt }] }`) and revokes one (`POST /v1/projects/{project}/agents/{tokenId}/revoke`);
  - the tool revokes its own token with `POST /v1/auth/agent/revoke` (`npx @meyer0x/socrate logout`).
- **Backup and restore**: delegated tokens, like sessions and read tokens, are not exported; after a restore, every agent runs `npx @meyer0x/socrate login` again.

## Writes with a delegated token

Every write carries an `Idempotency-Key` header (8 to 128 characters `A-Za-z0-9_-`). The same key with the same payload returns the first result (`200` instead of `201`); with another payload, `409 idempotency_conflict`. After a lost answer, retry with the same key. An archived review is read-only (`409 review_inactive`).

| Write | Route | Body | Answer |
|---|---|---|---|
| Reply to a thread | `POST …/reviews/{review}/threads/{threadId}/messages` | `{ body }` | the message, `201` |
| Resolve | `POST …/reviews/{review}/threads/{threadId}/resolve` | `{ message, commit? }` | the message, `201` |
| Reopen | `POST …/reviews/{review}/threads/{threadId}/reopen` | `{ message }` | the message, `201` |

- `message` is required: the state change and its message are written in one batch, with one change-log entry. `commit` is hexadecimal, 7 to 40 characters.
- The existing rule applies: the author resolves and reopens their own threads; `thread.moderate` allows it on any thread (`403 forbidden` otherwise). A thread already in the requested state gives `409 state_conflict`; a concurrent change, `412 state_conflict`.
- `PUT …/threads/{threadId}/state` (the browser's state change, without message) is refused to a delegated token.

Each message has `via`, the name of the agent that wrote it in the person's name (`null` from the browser), and `transition`, `null` for a plain message. A resolution or reopening message carries `transition: { state, commit, deploymentId, liveSince, liveState }`: `commit` as sent; for a resolution `deploymentId`, the latest non-revoked deployment of the review at the time of the write, which is almost always a build without the fix (kept for compatibility, not shown). `liveSince` and `liveState` are computed at each read for a resolution with a commit, `null` otherwise: `liveSince` is the `createdAt` of the first non-revoked deployment of the review whose commit matches `commit` (prefix in either direction, since lengths differ); `liveState` is `live` when that deployment exists, `pending` while no non-revoked deployment was created after the resolution, and `unknown` once one was, under another commit. The service knows no Git ancestry: a later build may contain the fix without carrying that exact commit, so nothing is asserted then. These fields appear in every thread read, list and change-log read; both are absent from services older than 0.3.0. The panel shows "Karim Benali · via Claude" then "Corrigé par Claude · en ligne depuis 11 h 24" (`live`), "Corrigé par Claude · en attente de la prochaine preview" (`pending`) or "Corrigé par Claude" (`unknown` or older service), with the short commit on hover; without commit, or written by a person, "Résolu par …". `socrate thread` prints "fixed in abc1234 · live since 2026-10-27 11:24 UTC", "· waiting for the next preview" or nothing more, and every time in UTC.

## Read token, for automation without a person

A read token is a random bearer limited to one project with the single capability `review.read`, stored as a hash with an expiry. Locally, the launcher writes it to `.local/runtime/<instance>/credentials/agent.token` (mode 0600). On a deployed instance, issue it with `npm run distant -- acces-lecture` (see [self-host-cloudflare.md](self-host-cloudflare.md#7-read-token-for-coding-agents)) and write it to a file of mode 0600. Everything below also works with a delegated token.

- The bearer only travels in `Authorization: Bearer …`, never in a URL. The service logs neither headers nor bodies.
- It reads every review of its project and nothing of another project (`403 forbidden`).
- It writes nothing: publishing, replying, changing a state, importing or uploading answers `403 forbidden` without any write.
- Reads depend neither on a reviewer session nor on the original deployment: the preview URL may be gone.

## Preamble of the examples

Each example assumes this preamble in the same POSIX shell. `socrate` passes the bearer to `curl` through its configuration on standard input, so it appears neither in the URL nor in the process arguments. `-q` ignores any personal `.curlrc`.

<!-- example: preambule -->
```sh
: "${SOCRATE_URL:?service URL, for example http://127.0.0.1:8787}"
: "${SOCRATE_PROJECT:?project, for example demo}"
: "${SOCRATE_TOKEN_FILE:?file holding the read bearer}"
socrate() { printf 'header = "Authorization: Bearer %s"\n' "$(cat "$SOCRATE_TOKEN_FILE")" | curl -q -sS -K - "$@"; }
```

## Resources

| Resource | Route | Response |
|---|---|---|
| Reviews of the project | `GET /v1/projects/{project}/reviews` | `{ items: [{ projectId, reviewKey, state, createdAt, archivedAt, purgeAfter, purgedAt, latestDeployment }] }` |
| Deployment and revision | `GET /v1/projects/{project}/reviews/{review}/deployments/{id}` | revision manifest, URL, commit |
| Revision | `GET …/revisions/{revisionId}` | the manifest imported for that revision |
| Threads of a review | `GET /v1/projects/{project}/reviews/{review}/threads` | page of threads with messages |
| One thread | `GET …/threads/{threadId}` | one thread with messages |
| Changes | `GET …/changes?since={marker}` | threads changed after the marker |
| Capture | `GET …/captures/{captureId}` | PNG bytes only |
| Attachment | `GET …/attachments/{attachmentId}` | the attachment bytes only |

<!-- example: revues -->
```sh
socrate "$SOCRATE_URL/v1/projects/$SOCRATE_PROJECT/reviews"
```

A review has `state` `active`, `archived`, `purging` or `purged`. `archivedAt`, `purgeAfter` and `purgedAt` are `null` until the review is archived or purged; `latestDeployment` is `{ deploymentId, revisionId, url, createdAt }`, or `null` before the first import.

A thread has `threadId`, `kind` (`global` or `targeted`), `state` (`open` or `resolved`), `version`, the original `revisionId` and `deploymentId`, `author`, `createdAt`, `updatedAt` and `messages` (replies included, in `seq` order). Depending on the case:

- **General comment**: `target`, `capture` and `proposal` are `null`. The first message holds the comment.
- **Targeted comment**: `target` gives URL, route, frame, rectangle, viewport, role, text, selector and a sanitized HTML excerpt of the element. `capture` is `{ captureId, status: "available", contentType, size, sha256, width, height }`, without bytes.
- **Wording proposal**: `proposal` gives `original`, `replacement`, `sourceRevisionId`, `wording` (`null` for free text) and `drift` (see below).

Each message also has `attachments` (an empty list when there is none), `via` and `transition` (see [Writes with a delegated token](#writes-with-a-delegated-token)). An attachment has `attachmentId`, `name`, `contentType`, `size` in bytes and `sha256`. A message made only of attachments has an empty `body`. Attachment bytes are read with the same bearer and come with the validated type, `Content-Length`, a SHA-256 `ETag`, `Cache-Control: no-store` and `X-Content-Type-Options: nosniff`. There is never a public URL, nor any image or base64 in the JSON.

### Wording proposals

`original` is frozen at publication: for a prepared wording, the service takes it from the observed revision, never from the browser payload; for free text, it is the `target.text` excerpt. `drift` compares the original with the reference revision of the read (the latest imported deployment, for an agent): `current` (unchanged), `changed` (`currentSource` gives the new source) or `removed`. It is computed at each read, so a new import can change it without any change-log entry.

## Pagination

The list read with a technical token is frozen at the first call. In the same D1 batch, the service selects the threads matching the filters, fixes their order and records the ceiling of the change log. Following pages read these ids back, in that order, each once.

- **Order**: creation time ascending, then `threadId`.
- **Membership**: a thread that was a member at the first call stays in the list even if it changes meanwhile, for example if it is resolved while the filter asked for open threads. A thread created after the first call does not enter it.
- **Values**: each page returns the current value of its threads, possibly newer than the first call. The change log reports what changed.
- **Size**: `limit` from 1 to 100, 20 by default.
- **Response**: `{ items, nextCursor, changesSince, filter, total, expiresAt }`. `nextCursor` is `null` on the last page.
- **Cursor**: `l1.<list>.<position>`, opaque. It carries the filters of the first call. A following page accepts only `cursor` and `limit`; an added filter is refused with `422`.
- **Expiry**: fifteen minutes after the first call, then `410 resync_required`.

<!-- example: retours-ouverts -->
```sh
socrate "$SOCRATE_URL/v1/projects/$SOCRATE_PROJECT/reviews/$SOCRATE_REVIEW/threads?state=open&limit=2"
```

Set `CURSOR` to the received `nextCursor`:

<!-- example: page-suivante -->
```sh
socrate "$SOCRATE_URL/v1/projects/$SOCRATE_PROJECT/reviews/$SOCRATE_REVIEW/threads?cursor=$CURSOR&limit=2"
```

## Filters

Validated at the boundary and frozen at the first call.

| Parameter | Values | Semantics |
|---|---|---|
| review | `{review}` path segment | a review of the project; unknown: `404 not_found`; existing without thread: `200` with `total: 0` |
| `state` | `open`, `resolved` | state at the first call; absent: all |
| `updatedSince` | UTC ISO 8601 instant ending in `Z` | `updatedAt >= updatedSince`, inclusive |
| `updatedBefore` | UTC ISO 8601 instant ending in `Z` | `updatedAt < updatedBefore`, exclusive |

A reply, a resolution and a reopening move `updatedAt`. An unknown, repeated or malformed parameter gives `422 invalid_request` with the faulty path. Timestamps are stored to the millisecond; a more precise bound is applied exactly. Inverted bounds give an empty list. The largest accepted bound is `9999-12-31T23:59:59.9999Z`.

<!-- example: resolus-depuis -->
```sh
socrate "$SOCRATE_URL/v1/projects/$SOCRATE_PROJECT/reviews/$SOCRATE_REVIEW/threads?state=resolved&updatedSince=$SINCE"
```

## Incremental reads

Every thread creation, reply, resolution and reopening writes a change-log entry in the batch of the mutation. An idempotent replay or an already reached state writes nothing. The log only finds the touched threads; their values always come from the business tables.

- Marker: `c2.<epoch>.<scope>.<seq>`, opaque. The first one is `changesSince` of the list. The scope binds it to the project and the review: a marker used on another review is refused with `422 invalid_request`.
- An older `c1.<epoch>.<seq>` marker, without scope, answers `410 resync_required`: restart the list without a cursor and continue from its `changesSince`.
- `GET …/changes?since=<marker>&limit=<n>` returns `{ items, next, more }`: the threads touched after the marker, whatever their state, with their current value. `limit` bounds the log entries read; a thread touched several times appears once per page.
- Continue with `since=<next>` while `more` is `true`, then keep `next` for the next read. A thread returned by the incremental read replaces the version already read with the same `threadId`.
- Lossless full read: read every page of the list, then the incremental read from `changesSince`.

Set `MARKER` to `changesSince` or to the last `next`:

<!-- example: changements -->
```sh
socrate "$SOCRATE_URL/v1/projects/$SOCRATE_PROJECT/reviews/$SOCRATE_REVIEW/changes?since=$MARKER"
```

## Captures

Capture bytes are read alone, by id, with the same rights as the thread. Response `image/png`, `Cache-Control: no-store`, `X-Content-Type-Options: nosniff`, and an `ETag` equal to the `sha256` announced in the thread. An unknown capture or one of another review gives `404 not_found`.

<!-- example: capture -->
```sh
socrate -o "$CAPTURE_FILE" "$SOCRATE_URL/v1/projects/$SOCRATE_PROJECT/reviews/$SOCRATE_REVIEW/captures/$CAPTURE_ID"
shasum -a 256 "$CAPTURE_FILE"
```

## After a deployment is revoked

Revocation ends reviewer sessions on that deployment and refuses new ones. It takes nothing from the technical token: list, change log from an already received marker, threads and images read as before, with the same ids, messages, originals and checksums. Threads keep their original `deploymentId` and `revisionId`. Revocation writes no change-log entry.

## Errors

Every error returns `{ code, message, requestId, retryable, issues? }` with `Cache-Control: no-store`. Messages are in French.

| Status | Code | Case | Retry |
|---|---|---|---|
| 401 | `unauthenticated` | missing, unknown, expired or revoked bearer | no, new token (`npx @meyer0x/socrate login` for a delegated one) |
| 403 | `forbidden` | other project, missing capability, any write with `review.read`, a write outside reply/resolve/reopen with a delegated token, `Origin` with a delegated token | no |
| 404 | `not_found` | unknown review (list and log), thread or capture | no |
| 410 | `resync_required` | unknown or expired cursor, changed epoch, unscoped `c1` marker | restart the list without a cursor |
| 409 | `state_conflict`, `review_inactive`, `idempotency_conflict` | thread already in that state, archived review, key reused with another payload | no |
| 412 | `state_conflict` | thread changed during the write | yes, after reading it again |
| 422 | `invalid_request` | invalid parameter, filter added to a cursor, cursor or marker of another review, missing `message` | no, fix the request |
| 429 | `rate_limited` | too many pending codes, too many unknown codes typed | later |
| 503 | `persistence_uncertain`, `not_ready` | storage or schema unavailable | yes |

The epoch changes when a restore or a purge invalidates the log.

A write with the read token:

<!-- example: ecriture-refusee -->
```sh
socrate -o /dev/null -w '%{http_code}\n' -X POST -H 'Content-Type: application/json' -H 'Idempotency-Key: agent-essai-0001' --data '{"kind":"global","body":"essai"}' "$SOCRATE_URL/v1/projects/$SOCRATE_PROJECT/reviews/$SOCRATE_REVIEW/threads"
```

## Limits

- The list of reviews of a project is not paginated.
- A reviewer session always reads `GET …/threads` in full, for the client. Pagination applies to technical tokens.
