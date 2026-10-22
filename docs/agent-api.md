# Agent API: read the feedback of a review

This guide is for the coding agent that collects the feedback of a review. The API is read-only JSON and works from a terminal, without a browser. It triggers nothing: no feedback calls an agent, a webhook or a notification. The agent reads when it decides to.

Every `sh` block below marked `<!-- example: … -->` is executed verbatim against a real Worker by `apps/service/test/agent-api.test.ts`.

## Authentication

A read token is a random bearer limited to one project with the single capability `review.read`, stored as a hash with an expiry. Locally, the launcher writes it to `.local/runtime/<instance>/credentials/agent.token` (mode 0600). On a deployed instance, issue it with `npm run distant -- acces-lecture` (see [self-host-cloudflare.md](self-host-cloudflare.md#7-read-token-for-coding-agents)) and write it to a file of mode 0600.

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

Each message also has `attachments` (an empty list when there is none). An attachment has `attachmentId`, `name`, `contentType`, `size` in bytes and `sha256`. A message made only of attachments has an empty `body`. Attachment bytes are read with the same bearer and come with the validated type, `Content-Length`, a SHA-256 `ETag`, `Cache-Control: no-store` and `X-Content-Type-Options: nosniff`. There is never a public URL, nor any image or base64 in the JSON.

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
| 401 | `unauthenticated` | missing, unknown or expired bearer | no, new token |
| 403 | `forbidden` | other project, missing capability, any write | no |
| 404 | `not_found` | unknown review (list and log), thread or capture | no |
| 410 | `resync_required` | unknown or expired cursor, changed epoch, unscoped `c1` marker | restart the list without a cursor |
| 422 | `invalid_request` | invalid parameter, filter added to a cursor, cursor or marker of another review | no, fix the request |
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
