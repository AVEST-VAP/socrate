# 0009. Delegated agent tokens by device authorization

Within ADR 0006. Usage: [agent-api.md](../agent-api.md#delegated-login), [packages/socrate/README.md](../../packages/socrate/README.md#for-coding-agents).

## Context

A coding agent read feedback with a `review.read` token issued by the operator with cloud access. It could neither reply nor resolve: every write required a five-minute reviewer session opened in the browser. Developers want their agent to read, answer and resolve the threads of their pull request in their own name, shown as such, and to connect it simply and safely without an operator.

## Decision

The developer runs `npx @meyer0x/socrate login`; the service starts a device authorization (RFC 8628, adapted) and the developer approves the displayed code in the Socrate panel of a preview where they are already signed in. The identity comes only from that panel's Socrate session, itself issued from the host backend's assertion (ADR 0006). The host backend changes nothing.

- **Start** (`POST /v1/auth/device`, unauthenticated): project, agent name, machine name. The service stores the hash of a 256-bit `deviceCode` and an 8-character `userCode` from an alphabet without ambiguous characters, valid 10 minutes, at most 20 pending per project.
- **Decision** (session routes under `/v1/projects/{project}/devices/{userCode}`): details, then approve or deny. Approval is refused while exploring a customer account, without `thread.participate`, after expiry, after a decision, and for a code of another project. It freezes the real actor, the agent and the capabilities of the session (`review.read`, `thread.participate`, `thread.moderate` if present), intersected with the project policy.
- **Exchange** (`POST /v1/auth/device/token`, unauthenticated): `authorization_pending`, `slow_down`, `access_denied`, `expired_token`, then the token once; a second exchange gives `invalid_grant`. Consuming the code and creating the token are one D1 batch.
- **Token**: 256 bits, hashed, project-wide, fixed 30-day expiry without sliding renewal. It reads like `review.read` and only replies, resolves and reopens. Resolution and reopening require a message written atomically with the state change; resolution records an optional commit and the latest non-revoked deployment of the review. Messages record `via`. Idempotency keys work as for browser intentions.
- **Revocation**: from the panel (the actor's own tokens) and by the token itself (`npx @meyer0x/socrate logout`), effective at the next request. Tokens are not backed up: a restore revokes them.
- **Schema**: migration `0008_agent_tokens.sql` adds `device_authorizations`, `device_attempts`, `agent_tokens` with freeze triggers, and nullable columns `via`, `transition`, `commit_sha`, `deployment_id` on `messages`. Routes and fields are only added: the `0.1.0` client and existing `review.read` tokens work unchanged.

## Rejected alternatives

- **GitHub OAuth (or another identity provider).** It proves a GitHub account, not the person signed in to the host application, and a mapping between the two would be a second identity source to administer. It also brings a dependency the self-hosted service does not have today.
- **Redirect to a local port** (OAuth loopback redirect). It needs a browser on the same machine as the agent, which is false for remote and sandboxed agents, and the preview origin would have to redirect to `127.0.0.1`, a new open-redirect surface.
- **Tokens copied from the panel.** Showing a long-lived bearer in the page exposes it to every script of the preview origin, to screenshots and to the clipboard; the panel would have to mint tokens from a five-minute session. A code typed in the panel carries no secret: the secret stays in the tool.

## Threats and mitigations

- **Phishing of the code.** An attacker runs `npx @meyer0x/socrate login` and asks a victim to approve its code. The panel shows the agent, the machine name and the project before the decision, with the warning "N’approuvez que si vous venez de lancer cette commande."; in the panel, approval requires an explicit click in the victim's own signed-in session (a script injected in the preview needs no click, see below); the code dies after 10 minutes; the resulting token cannot create threads or proposals, only answer and change state with a visible "via"; the victim sees it under "Mes agents" and revokes it.
- **Brute force of the code.** 26⁸ ≈ 2·10¹¹ codes, at most 20 pending per project, a 10-minute life. Lookups of unknown codes count per actor and project, so renewing the session does not reset the count: after 5 failures in 10 minutes, every lookup is refused. Each lookup reserves its attempt before reading, in the statement that counts the window, so parallel lookups cannot exceed the limit; a found code releases its reservation. Malformed codes are refused without a database lookup and count too.
- **Theft of the credentials file.** The CLI stores tokens under `$XDG_CONFIG_HOME/socrate/` (directory 0700, file 0600), never in the repository, never printed (outputs are redacted). A stolen token is bounded: one project, 30 days, no creation, no archive or purge, revocable from the panel, `lastUsedAt` visible.
- **Use from a page.** A request with a delegated token and any `Origin` header is refused, as are start and exchange with `Origin`: a page can neither start a login, nor exchange a code, nor use a delegated token from the browser. Browser sessions keep their exact-origin rule. This does not stop a script injected in a preview from approving a code, below.
- **Script injected in a preview (residual risk).** A script running in a preview can obtain a session through the host's identity bridge, as the panel does, then approve without any click a code the attacker started on their own machine. The attacker then holds a 30-day token on the project, limited to reading, replying, resolving and reopening, instead of a 5-minute session. The service cannot tell this approval from a real one. Mitigations: the agent appears under **Mes agents** for the person whose session approved it, with the agent name and the machine name; the person revokes it there, effective at the next request; every message and state change it writes shows "via" and the agent name. Keeping injected scripts out of previews remains the host's responsibility, as for sessions.
- **Policy drift.** Capabilities are intersected with the project policy at approval, at exchange and at every request; removing `thread.participate` from the policy disables every delegated token of the project.

## Consequences

- One more credential kind in `authenticate`, after sessions and technical tokens. The lookup costs one indexed read; `lastUsedAt` is written at most once a minute per token.
- The `slow_down` interval is stored per code. The cleanup of expired codes and old failures runs at each start.
- Deployment order: the Worker is updated before clients. As for every migration, the Worker refuses a database whose schema it does not know: apply `0008_agent_tokens.sql` and deploy the Worker together.
