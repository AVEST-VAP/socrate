# 0006. Contracts of version 1

It fixes the shape of the product; later ADRs refine it.

## Shape

A contract package owns versioned schemas and HTTP errors. A React package exposes one public component with three inputs: preview context, verifiable identity function, navigation adapter. The service URL belongs to the preview context. React and React DOM are peer dependencies. The Worker owns authentication, imports and discussions, with business rules separate from D1/R2 storage. No driver framework, bus, full event sourcing or second business server.

## Manifest, version and identity

Keep `.socrate/index.json` and its JSON fragments. The assembler refuses missing referenced files, unknown or invalid data, traversal, symbolic links leaving the folder, remote references and executable code. An unreferenced data file is a preparation error; a README is not a fragment. The service validates the assembled manifest again. Errors give the file and the data path when known.

The revision is the digest of the validated manifest canonicalized with RFC 8785, scoped by project and review. Identical content in two projects shares no row and no media. A deployment has an immutable id and points to its revision. An identical import converges; the same id with a different payload returns `409 immutable_deployment`. The browser loads its own revision, not the latest one imported.

Identity uses an ES256 assertion with explicitly configured algorithm, issuer and public key, no key fetched from a URL in the token, 60 seconds of validity and a bounded clock skew. Required claims: issuer, audience, real actor, attested name, dates, unique id, project, review, deployment, origin and requested capabilities. The impersonated account is a separate context. The server intersects attested capabilities with the project policy; a form field never grants the developer role.

The exchange atomically consumes the assertion id and issues an opaque random 256-bit session valid five minutes, stored as a hash. A replayed assertion is refused; a lost response leads to a new assertion. The browser keeps only its Socrate session, in memory; no host token reaches the service, a URL or a log.

Every browser request enforces the exact origin and session scope. Technical tokens have a project scope and explicit, distinct capabilities, with expiry and hashed storage. Import grants neither participation, nor archive, nor purge.

## Durable writes and reads

A mutation carries an idempotency key bound to the stable actor, project, review, operation type and canonical payload digest. Identical replay, same durable result; different payload, conflict. Author and date are set by the server. A state change checks rights and an expected version; an intention already fulfilled creates no second event.

The relational writes of a mutation and its change marker belong to the same D1 batch. An UPDATE that touches zero rows is not a rollback: every insert conditioned on ownership or an active review expresses that condition itself. Constraints and concurrent tests prove the absence of false success.

A targeted publication reserves an operation in D1 before the R2 `PUT`, uses an operation-specific object key and immutable bytes. The batch that makes the thread visible checks the reservation, the payload, the review state and ownership of the attempt (a nonce). Cleanup atomically claims an expired operation and never deletes the object of a committed operation; no cleanup is based on age or on a stale read alone.

A minimal change log supports incremental reads, including a resolution seen by a client that was reading open threads. It is not a second source of truth. An epoch invalidates cursors after a restore or a purge with `410 resync_required`.

Pagination freezes membership and order of the filtered results at the first call: a temporary list of ids selected transactionally, bound to scope, filter, epoch and expiry. Later mutations are picked up by the change log from the initial ceiling. Returned values may be newer, and this is documented. Paginating on a mutable key while announcing a stable view is rejected: a thread already read could come back and a state filter could lose a member.

Errors distinguish authentication, permission, contract, conflict and uncertain persistence, and say whether a retry makes sense. Private responses use `Cache-Control: no-store`, exact CORS and `Vary: Origin`. Images are read separately with the same rights and `nosniff`, never inside JSON lists.

## Client, focus and capture

The client renders in a same-origin `about:blank` iframe owned by Socrate, through a portal with a single copy of React; its styles stay in that document. It does not shrink the scene to capture. The only permanent interception is filtered to Socrate's own controls; business gestures are intercepted only during target selection. No mutation of private attributes of the host's UI library.

Before each image and after any change, the client checks the capture handle, invalidates on route, target or viewport change, and converts CSS coordinates to image coordinates by measurement. Video rendering and two animation frames alone do not prove freshness: tests compare the visible content and check that Socrate's controls are absent from the image. Any interruption before publication keeps the text for the life of the page but requires a new explicit targeting. Cancelling stores nothing; replies, states, general comments and proposals from the list do not use capture.

Editorial attributes, like Socrate's imports, styles and manifests, disappear outside preview builds, proven on build artefacts and network traffic.

## Runtime and operations

Programmatic Miniflare runs the real Worker with local D1/R2, on a pinned release whose options are checked. Outbound network refused, remote Cloudflare metadata and dev registry disabled, loopback only, explicit roots and caches. Numbered migrations with checksums and exclusive access before HTTP.

Backup is a logical export under an exclusive freeze of all writes, with consistent D1 and R2 inventory, manifest and digests, then restore into an empty instance, without relying on Miniflare's internal file format. Restored sessions and tokens are revoked, the epoch renewed. Purge uses a durable state and a replayable progression and never reports success while an in-flight write could recreate an object. The 30-day archive retention is configurable. Backups are kept until explicitly deleted; purging the active instance does not erase existing backups; restoring an older backup is an explicit, isolated operation.
