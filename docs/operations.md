# Operations: archive, purge, backup, restore

These commands target a local instance started by `npm run demo` (or `npm run parcours-local`). They exist because a local instance can be stopped and locked; a remote Cloudflare instance has neither guarantee, see the limits of [self-host-cloudflare.md](self-host-cloudflare.md). Decisions: [ADR 0008](adr/0008-archive-purge-backup.md).

## Technical tokens

`npm run demo` writes three tokens under `.local/runtime/<instance>/credentials/`, mode 0600: `import.token` (`deployment.import`), `agent.token` (`review.read`) and `archive.token` (`review.archive`). Only the last one archives or purges, and it reads nothing.

## Archive

```sh
SERVICE=http://127.0.0.1:8787
ARCHIVE="$PWD/.local/runtime/demo/credentials/archive.token"
curl -q -sS -X POST -H @- "$SERVICE/v1/projects/demo/reviews/rappels-automatiques/archive" <<EOF
Authorization: Bearer $(cat "$ARCHIVE")
EOF
```

`200` returns `state: "archived"`, `archivedAt` and `purgeAfter` (30 days later by default). A second call returns the same dates. An archived review stays readable by the API and the client until it is purged; every write answers `409 review_inactive`, including a new deployment. `archiveRetentionDays` (1 to 3650) applies to later archives. Revoking a deployment archives nothing.

## Exclusive maintenance

Purge, backup, restore and unfreeze run through `npm run sauvegarde -- <action>`; capture cleanup through `npm run nettoyer-captures`. The instance must be stopped (Ctrl+C on `npm run demo`, with a confirmed stop). The command takes the instance lock, checks that the ownership record shows every previous resource closed, then starts its own Worker closed to ordinary routes.

- Instance running: refused with `occupied`, nothing touched.
- Previous owner gone without proven shutdown: refused with `uncertain_resources`, root kept as is. Check by hand that no `workerd` of this instance is running.
- Maintenance Worker shutdown not confirmed: refused with `close_unconfirmed`; the root stays refused afterwards.

## Purge

```sh
npm run sauvegarde -- purger --instance demo [--projet demo] [--acces <token file>]
```

The `review.archive` token is read from `archive.token` or from `--acces`; it never appears in arguments or output. On a running instance, `POST /v1/projects/<project>/purge` answers `409 maintenance`.

The output is the log of the pass, one line per entry: review, action (`deleted`, `kept`, `waiting`, `purged`), resource and detail. Actions other than `kept` are also written to the `purge_log` table.

- `complète` (exit 0): no review of the project is still purging or archived and expired. Their captures answer `404`, their sessions `401`, their lists `404`.
- `incomplète` (exit 1) with `waiting`: another pass holds a review, or an object appeared despite maintenance. Run the command again.
- A pass with nothing to do deletes and writes nothing.
- A purge renews the epoch: `l1` cursors and `c2` markers issued before answer `410 resync_required`; agents restart their list without a cursor.

## Backup

```sh
npm run sauvegarde -- sauvegarder --instance demo
```

Under maintenance, the backup freezes D1, exports the tables and the committed images, checks every checksum, inventories temporary objects, then unfreezes. Output: the folder `.local/sauvegardes/demo-<date>/` and the SHA-256 of its manifest. Write it down: restoring requires it. The manifest lists the schema, the starting epoch, each file with its checksum, and what was deliberately not exported (sessions, technical tokens, frozen lists, uncommitted reservations).

Backups are kept until you delete their folder. A purge of the active instance never changes a backup, so a backup can contain feedback that the purge erased: delete the folder when that feedback must no longer exist.

If a backup is interrupted, the instance stays frozen and answers `503 maintenance`. After checking that no backup is running: `npm run sauvegarde -- degeler --instance demo`.

## Restore into an empty instance

```sh
npm run sauvegarde -- restaurer --instance demo-restored --depuis .local/sauvegardes/demo-<date> --empreinte <manifest sha256>
```

Before creating the target, the restore refuses links or non-file entries, missing, extra or altered files, a different checksum, malformed manifest or rows, a capture without its identical object, a schema different from the build, and an existing target instance. It never replaces the active instance. Afterwards:

- no earlier session or technical token exists: they answer `401`, and new tokens are written under `.local/runtime/demo-restored/credentials/`;
- the epoch is new: old cursors and markers answer `410 resync_required`;
- `/v1/health` returns `restoredFrom` with `state: "complete"`, the backup date, the restore date and the manifest checksum;
- an archived review keeps its original purge date.

An interrupted restore leaves the `in_progress` mark and no token; every start of that instance is then refused. Keep the folder for inspection and restore into another empty instance name.

To open the client on the restored instance: `SOCRATE_INSTANCE=demo-restored npm run demo`, with the same host port as the original instance (the deployment import is immutable and includes the URL).

## End of the work in the app repository

When a review is done, remove `.socrate/` from the app repository in the final commit. The service keeps every imported revision: an old thread is still explained by `GET …/revisions/{revisionId}` with the agent token. Then archive the review to start the retention period.
