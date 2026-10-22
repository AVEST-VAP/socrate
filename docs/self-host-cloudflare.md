# Self-host on Cloudflare

The reference deployment is one Cloudflare Worker, one D1 database and one R2 bucket. `npm run distant` prepares files under `apps/service/dist/` and prints each `wrangler` command to run. It never calls Cloudflare itself, so you stay in control of every remote effect.

This procedure is replayed against a local D1 by `tools/local/test/distant.test.ts`. The repository's tests do not exercise it against Cloudflare.

## What the Worker serves

- The API under `/v1/` (sessions, imports, threads, captures, attachments, agent reads, archive).
- `GET /v1/client` returns `200 {"url": "https://<worker>/client/<hash>.js"}`, uncached: the `mount` entry of the deployed build. Read it once per preview build and freeze it in the bundle, or read it at runtime.
- `GET /client/<file>.js` serves the entry and its chunks on demand (React included; the video converter is loaded only when a video needs it), with `Cache-Control: public, max-age=31536000, immutable` and `Vary: Origin`. `Access-Control-Allow-Origin` is sent only to a registered, non-revoked deployment origin, as for the API.
- Old hashes stay in `apps/service/dist/assets/client/` from one build to the next, so a preview frozen on an older client still loads it after a new deployment, as long as that folder is kept. After deploying from a fresh clone, rebuild the open previews.

## Prerequisites

- A Cloudflare account, a D1 database and an R2 bucket (dashboard, Terraform, or `npx wrangler@4.116.0 d1 create <name>` and `npx wrangler@4.116.0 r2 bucket create <name>`).
- An API token with Workers, D1 and R2 permissions, exported only in the deployment terminal: `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, and `WRANGLER_SEND_METRICS=false` if you wish.
- `npm ci` in this repository. `npx wrangler@4.116.0` downloads wrangler on first use; Socrate does not install it. This exact version embeds the same workerd as the `miniflare` pinned for local runs (`4.20260730.0`): change both together.

## 1. Assertion key

Generate the ES256 key pair once (see [integrate.md](integrate.md#1-identity-bridge)). The public JWK goes in `SOCRATE_CONFIG` at step 2. The private JWK goes only in your app backend's secret store, never in this repository.

## 2. Configuration and build

```sh
cp apps/service/wrangler.jsonc.example apps/service/wrangler.jsonc
```

Replace every `<…>` value: D1 name and id, R2 bucket name, public JWK. Rename the Worker if you like (`my-socrate` in the example, so its address is `https://my-socrate.<subdomain>.workers.dev`). For each project, set `issuer` to the exact `iss` of your assertions and `allowedOrigin` to your preview origin or pattern (see [integrate.md](integrate.md#origin-policy)). `apps/service/wrangler.jsonc` is ignored by Git.

Other settings of `SOCRATE_CONFIG`: `audience` (expected `aud`), `assertionMaxAgeSeconds` (at most 60), `clockSkewSeconds` (at most 60), `sessionTtlSeconds` (at most 300), `archiveRetentionDays` (1 to 3650, default 30), and per project `attestableCapabilities`. The schema is `serviceConfigSchema` in `packages/contract/src/config.ts`.

```sh
npm run distant -- preparer
```

The command validates `SOCRATE_CONFIG`, refuses any remaining `<…>` value and any project without `allowedOrigin`, builds the Worker and the hashed client, and writes `apps/service/dist/wrangler.json` with `main`, `no_bundle`, the assets (`run_worker_first`), `SOCRATE_SCHEMA` (migrations and checksums of this build) and the `build` digest of `SOCRATE_INSTANCE`.

## 3. Remote migrations

Remote migrations follow the local contract: each migration is recorded in `schema_migrations` with its SHA-256 checksum, and the Worker refuses a divergent schema. `wrangler d1 migrations` is not used because it keeps its own table without those checksums.

```sh
npm run distant -- migrations
```

Without arguments, the command prints the read to run first:

```sh
npx wrangler@4.116.0 d1 execute <database> --remote --config apps/service/dist/wrangler.json --json --command "SELECT id, checksum FROM schema_migrations ORDER BY id" > apps/service/dist/appliquees.json
```

Then run `npm run distant -- migrations --appliquees apps/service/dist/appliquees.json`, or `--base-vierge` for an empty database (when the read reports that `schema_migrations` does not exist). The script refuses a divergent prefix (unknown migration, different order or changed checksum). Otherwise it writes one file per pending migration under `apps/service/dist/migrations-distantes/`, each ending with its `INSERT INTO schema_migrations`. Run the printed commands one at a time, in order.

The atomicity of a remote `d1 execute --file` is not verified. If a file fails midway, do not rerun it: read `schema_migrations` and the database state before any manual recovery.

## 4. Deploy

```sh
npx wrangler@4.116.0 deploy --config apps/service/dist/wrangler.json
```

Checks:

- `GET https://<worker>/v1/health` answers `200` with the expected `schema` list;
- `GET https://<worker>/v1/client` answers `200` with a `…/client/<hash>.js` URL.

Missing migrations give `503 not_ready`; a divergent schema gives `500 schema_incompatible`. Give the Worker URL to your app's preview build (for example as `SOCRATE_SERVICE_URL`).

## 5. Import token

```sh
npm run distant -- acces-import [--projet my-app] [--jours 365]
```

This creates a `deployment.import` token for the project (the only project of the configuration by default), valid 365 days by default (730 at most). The token is printed once and never written: `apps/service/dist/acces-import.sql` only contains its hash, and the command refuses to overwrite it. Run the printed `d1 execute --file` command, store the token as a CI secret of your app (for example `SOCRATE_IMPORT_TOKEN`), then delete the SQL file.

## 6. Archive token

Nothing is archived automatically. Issue the archive token once:

```sh
npm run distant -- acces-archive [--projet my-app] [--jours 365]
```

Same rules as the import token: printed once, only its hash in `apps/service/dist/acces-archive.sql`. Run the printed command, delete the file, and keep the token outside any repository and outside CI. It allows neither import nor reading.

## 7. Read token for coding agents

Agents read feedback with a `review.read` token:

```sh
npm run distant -- acces-lecture [--projet my-app] [--jours 365]
```

Same rules again: printed once, only its hash in `apps/service/dist/acces-lecture.sql`. Run the printed command and delete the file. Store the token in a file readable only by the agent (mode 0600), outside any repository, and point `SOCRATE_TOKEN_FILE` at it ([agent-api.md](agent-api.md)). The token reads every review of its project, archived ones included, and writes nothing.

## Archive a review

When a pull request is closed, keep the token in a file readable only by you and send it through standard input, never as an argument:

```sh
SERVICE=https://my-socrate.<subdomain>.workers.dev
curl -q -sS -X POST -H @- "$SERVICE/v1/projects/my-app/reviews/my-app-pr-42/archive" <<EOF
Authorization: Bearer $(cat "<review.archive token file>")
EOF
```

`200` returns `state: "archived"`, `archivedAt` and `purgeAfter` (`archiveRetentionDays` later). A second call returns the same dates. An unknown review answers `404`, an import token `403`. The archived review stays readable, but every write answers `409 review_inactive`, including a new import: builds of a pull request reopened after archiving are no longer imported.

## Limits

- No cron. Cleaning expired capture reservations, purging and backing up are not automated on a remote instance. Use D1 exports (`wrangler d1 export`) for backups.
- The full purge of archived reviews exists only for a stopped local instance ([operations.md](operations.md)). On a remote instance, `purgeAfter` is informative: no data is deleted.
- Tokens do not renew themselves. When the import token expires, CI imports fail with `401`: issue a new token and replace the secret.
