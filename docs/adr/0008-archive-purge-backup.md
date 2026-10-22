# 0008. Archive, purge and backup of a local instance

Within ADR 0006. Procedures: [operations.md](../operations.md).

## Review state

`reviews` has four states: `active`, `archived`, `purging`, `purged` (migration `0006_operations.sql`). Every write already required `state = 'active'` in its own statement, so archiving is enough to refuse publication, reply and reservation. The three paths without that condition received it inside the statement: state change (and recording an already reached transition), import of a new deployment, session opening (deployment present, not revoked, review not purged). The `purged` row stays as a content-free tombstone: it explains the purge and prevents an import from silently recreating the review.

The purge date is fixed when archiving: `archived_at + archiveRetentionDays`, 30 days by default. Changing the configuration does not move an existing archive. Revoking a deployment or closing a preview does not touch `reviews`.

## Exclusive local maintenance

Purge, backup, restore, unfreeze and manual capture cleanup run only in an exclusive maintenance phase, opened by `npm run sauvegarde -- <action>` or `npm run nettoyer-captures` (`tools/local/maintenance.ts`). The phase exists only after two proofs:

1. the root lock is taken. The interactive launcher holds it for its whole life, so a running instance gives `occupied` and nothing is touched;
2. the ownership record of the previous owner shows every resource `closed`. A vanished owner without proven shutdown gives `uncertain_resources`, root kept, no forced stop or cleanup.

Together they establish that no earlier workerd runs, so no upload, import, session or publication is in flight. The phase then starts its own Worker with `SOCRATE_MAINTENANCE=exclusive`, which answers `503 maintenance` on every route except `/v1/health`; operations use the process's D1 and R2 bindings.

Admission does not rely on TypeScript's `private`, which disappears at runtime. It relies on a module-private `Symbol` that only `Maintenance.run` passes to the constructor after taking the root. Any other construction returns `not_exclusive`. The handle is frozen on its root and bindings, and closes at the end of the phase. Export, restore, purge and cleanup check it before any effect.

The guarantee covers instances started by the shipped commands (`demo`, `parcours-local`, `sauvegarde`, `nettoyer-captures`). Code that imports `purgeExpired` directly with its own bindings, or a process opening the same `persist` folder without these tools, is not covered. Nothing here applies to a remote service: remote D1 and R2 have neither this lock nor this shutdown.

## Purge

Only `review.archive`, reserved to technical tokens, opens `POST …/reviews/<review>/archive` and the purge. The running instance refuses `POST /v1/projects/<project>/purge` with `409 maintenance`. Under maintenance, one pass:

1. closes each expired review in one D1 batch conditioned on being taken by this pass: state `purging`, row counts per table, object keys kept in `purge_objects`, deletion of threads, messages, proposals, targets, captures, operations, log, sessions, deployments, revisions and frozen lists, and a new epoch;
2. deletes R2 objects from that durable list, then those of the review prefix without a row;
3. rereads the empty prefix and moves the review to `purged`. An object found anyway gives `waiting`, a sign that exclusivity was violated;
4. rereads the prefix of every already `purged` review and deletes and logs any leftover;
5. computes `complete` from the final durable state.

Identical content in another review or project is never shared, so the purge touches only the rows and prefix of its review.

## D1 freeze and backup

A single `maintenance` row and its triggers form a secondary D1 guard: while it is 1, every D1 write aborts and the Worker answers `503 maintenance`. They do not block an R2 `PUT`, so they do not prove exclusion; maintenance does. The backup sets the freeze during its export, then clears it.

The backup is a logical export through Miniflare's D1 and R2 APIs, never a copy of its internal files. It exports the business tables and committed capture and attachment objects with their checksums, then inventories the rest of the R2 prefix. Sessions, technical tokens, frozen lists, epoch and uncommitted reservations are not exported: they are revoked or invalidated by construction. A backup is refused during an unfinished purge.

## Restore

The manifest's SHA-256, printed by the backup, is mandatory and anchors every file. Before any effect, and before creating the target root, the restore refuses links or non-file entries, missing, extra, malformed or altered files, a manifest outside its schema (`@socrate/contract/backup`), non-scalar rows or malformed column names, wrong counts, a capture without its identical object, and a schema different from the build. Column names must exist in the target's `pragma_table_info` before any interpolation. Any non-empty target, hence the active instance, is refused.

The restore first writes a dated `restorations` row `in_progress`, then the rows, the objects reread with their checksum, the new epoch and the count checks, and only then `complete`. New technical tokens are issued only after that. An interrupted restore keeps `in_progress`: every start is refused, and no token exists. There is no global D1/R2 atomicity, only this honest mark.

Backups are kept until their folder is deleted. Restoring a backup older than a purge brings the purged reviews back, archived with their original date: the next pass purges them again.

## Rejected

Cold copy of the `persist` folder: depends on Miniflare's internal format. Scheduler, cron or automatic purge: not part of this version. A late-write delay or an orphan sweep as proof that writers stopped: they do not bound an in-flight `PUT`. D1 freeze as an R2 barrier: a SQLite trigger does not stop a `PUT`. In-place restore: it would substitute an older state for the active instance.
