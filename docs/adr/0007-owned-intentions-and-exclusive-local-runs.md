# 0007. Owned intentions and exclusive local execution

Refines ADR 0006 without changing the product or the three inputs of the component.

## Boundaries

The host keeps `<SocrateReview preview getIdentityAssertion navigation />` and remounts it with a `key` when the identity changes in the same tab. The client owns one stable controller per general comment, per reply and per state transition. At click time it passes the identity actually displayed; it never rebuilds a retry key from the current text.

```ts
const reply = useSubmission(client, { kind: 'reply', threadId });
reply.edit(text);
await reply.publish({ seen: displayedOwner });
await reply.retry();
// Explicit action after a warning: abandon the retry, not cancel a commit.
reply.abandon();

await localCommand({ action: 'launch', instance: 'demo', ports, reset: false });
await localCommand({ action: 'doctor', instance: 'demo' });
await localCommand({ action: 'cleanup', instance: 'demo' });

await threadCommands.reply({ scope, key, threadId, body });
```

`doctor` and `cleanup` read ports from the instance record. A refused local result exits non-zero. HTTP schemas, bearers, SQL, D1 results, paths and process handles stay behind their owners. No SQL framework, new system environment or daemon.

## Intention, identity and known result

An intention is immutable: key, payload, target, stable actor, impersonated account and draft revision. The controller reserves its state synchronously before the first `await`. The editable draft and the frozen intention are distinct but have one owner. Each emission captures a session, compares its actor and impersonated account with the frozen identity, then uses that same bearer. A GET, a concurrent 401 or a failed renewal never replaces the owner.

A Socrate session lives at most five minutes. A change in another tab is only known at the next assertion exchange; there is no instant cross-tab revocation. A retry under a still-valid session stays attributed to the frozen, displayed owner. As soon as a renewal reveals another actor or account, the retry is blocked without changing its owner or its unknown result.

The result distinguishes parsed success, certain refusal of this attempt, unknown response and blocked identity. An unknown attempt stays unknown through any later 401, 403, 404, 409, 412 or 422: an error on a new attempt does not prove the absence of an earlier commit. A first attempt entirely refused before any write releases the intention and keeps the text to fix. The server cannot produce a refusal presented as certain after its batch committed.

Abandon is available on the unknown and blocked states. Its text says the submission may already be published; it cancels no server write. The screen keeps the old payload and the current draft until that choice. An empty draft gets the old text back; a modified draft is never overwritten. A new publication needs a new click, a new key and the identity displayed at that moment.

After success, the draft is cleared only if its revision is still the one of the click. A failed reread only offers to read again. Hiding the client keeps controllers and drafts; a real remount ends them.

## Exclusive local resources

A single `local-run` boundary imports the Node built-ins, validates the instance and paths, enforces the local environment and network guards, then dynamically imports the libraries. Every documented entry point, test and skill goes through it. npm caches are enforced from `npm ci` on (`.npmrc`). `TMPDIR`, browsers, profiles, logs, artefacts and the Worker bundle belong to the working tree. No redefined `HOME`, inherited `NODE_OPTIONS`, external `.env` or cloud credential.

The instance name is bounded and validated before any effect. Lexical containment precedes `lstat`; ancestors under the canonical root are checked without following symbolic links. This is not a sandbox and does not resist a hostile writer with the same uid.

Exclusion uses a `node:sqlite` connection holding a `BEGIN EXCLUSIVE` transaction for the whole ownership of the instance or the deletion of its root. The lock file is a sibling of the root, outside the deletable area, and is never deleted, truncated or replaced. Corruption or an incompatible old lock is an explicit refusal, never a reset.

The private ownership record holds generation, nonce, control address and resource phases, published atomically under the lock. A durable state precedes each effect; the confirmed shutdown is recorded before the final release.

Cleanup tries to take the lock. If an instance holds it, cleanup asks it to stop through its authenticated, bounded private control. The owner closes its resources and releases. Cleanup then really acquires exclusion and rereads the generation; an instance started in between causes a refusal. No signal is ever sent to a PID or process group read from disk.

Releasing the lock after a crash does not prove that children stopped. A resource in phase `creating` or `running` without proof of shutdown may still bind a port after a probe. Closed ports and a missing parent PID do not authorize a destructive takeover: uncertain resources are refused, with the root kept and a usable diagnostic. Ordinary failures and launch timeouts must close every created resource. SIGKILL tests use witnesses owned by the test bench and prove the conservative refusal, not a recovery.

## Network, deadlines and diagnostics

Every Node request validates a loopback destination owned by the instance, refuses redirects before following them, and bounds headers, body and parsing by a monotonic deadline. Proof that a port is free is TCP: only `ECONNREFUSED` means nothing listens.

The browser factory alone owns contexts, routes and injected faults. It blocks Service Workers, configures HTTP and WebSocket routing before navigation, refuses redirects and sets positive timeouts. A loopback proxy sink receives any other destination and relays nothing. Miniflare keeps its outbound refusal, proven by a bench fixture.

`doctor` derives its verdict from all required checks, including that the storage exists and is physically the one of the instance and the build. Future migrations, a gap or a divergent checksum give `schema_incompatible` without reset. Credential provisioning compares hash, project, label, capabilities, validity and duration, and reissues only the divergent token without touching business data.

## Business commands

`publish`, `reply` and `setState` own their SQL, order, guards and named results; no caller coordinates D1 result arrays or guard fragments. Preconditions and postconditions are expressed in each dependent statement.
