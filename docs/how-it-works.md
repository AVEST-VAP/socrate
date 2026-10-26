# How Socrate works

## Glossary

This is the single glossary of the project. Code identifiers use the English terms; the UI is in French.

**Integrated project**: an application that uses Socrate. It owns its reviews and decides who may take part. Identified by a `projectId`.

**Review**: the durable set of explanations, questions and feedback around one piece of product work, usually one pull request. It can span several pages and outlives redeployments. Identified by a `reviewKey`.

**Preview**: a version of the application reachable by reviewers before release. Its address and lifetime do not define the lifetime of the review.

**Deployment**: one precise publication of the application, registered by CI with a `deploymentId`, a commit, a build id and a URL. Two deployments may serve the same review at the same address. A deployment is immutable and can be revoked.

**Review revision**: the immutable state of the explanations and questions prepared for one version of the work, identified by the digest of the canonical manifest. Old feedback keeps its original revision.

**Zone**: a part of the application that a reviewer understands, such as "reminder settings", with an entry route and instructions.

**Change marker**: an optional "New", "Changed" or "Feedback wanted" hint attached to a zone or a visible element.

**Question**: a precise question that deserves the product's judgement. It is neither an exhaustive test plan nor a formal sign-off.

**Wording under review**: a sentence selected for product review, with its context and variant. The selection may be empty.

**Target**: the element, text or area designated by the author of a feedback. A target may disappear in a later version without invalidating the feedback.

**Thread** (feedback): a discussion, open or resolved, started by a targeted comment, a wording proposal or a general comment. A reply belongs to its thread.

**Wording proposal**: a suggested replacement that keeps the original text and its context. It never changes the app's code or translations.

**Capture**: the image of the tab taken when a target is designated, stored with the published feedback. It is neither a recording of the session nor a reconstruction.

**Reviewer**: a person already signed in to the integrated application who explores and comments a review.

**Author**: the real person who publishes a message. A business account the person is impersonating is recorded separately as `exploring`.

**Archiving**: the end of the active period of a review, followed by a retention period before purge.

## Life of a review

1. **Preparation.** The developer or the coding agent adds a `.socrate/` folder to the app repository. A title, a before/now summary and at least one zone are required; change markers, questions and selected wordings are optional. See [integrate.md](integrate.md#the-socrate-manifest).
2. **Import.** For each preview build, CI sends `PUT /v1/projects/{project}/reviews/{review}/deployments/{deployment}` with the assembled manifest, the commit, the build id and the URL. The service validates the manifest, stores a revision (content-addressed by its RFC 8785 digest) and records the deployment's origin. Replaying the same import converges; the same id with a different payload is refused with `409 immutable_deployment`. The URL must match the project's `allowedOrigin` pattern.
3. **Review.** In the preview, the client asks the host backend for an identity assertion and exchanges it for a Socrate session. The toolbar appears without any prior click. Reviewers comment on an element, write a general comment, reply, resolve and reopen threads.
4. **Reading and answering.** The developer connects their coding agent once with `npx @meyer0x/socrate login`, approved in the preview. The agent lists the threads of the review, downloads the screenshots it needs, replies, and resolves a thread with a message and the commit that fixes it, in the developer's name. An automation without a person reads with a `review.read` token and follows the change log.
5. **Redeployment.** A new build is a new deployment, possibly with a new revision. Threads keep their original deployment and revision. A target that no longer exists stays explained by its screenshot and stored HTML excerpt.
6. **End.** Revoking a deployment ends reviewer sessions on it but keeps all data readable. Archiving the review makes it read-only and starts the retention period. Removing `.socrate/` from the app repository erases nothing in the service.

## Identity

Socrate has no user accounts. The host application vouches for its users.

- The host backend checks its own session, then signs a compact JWT with ES256, valid for at most 60 seconds, containing the real user (`sub`, `name`), the scope (`projectId`, `reviewKey`, `deploymentId`), the exact preview `origin`, the requested `capabilities` and, when the user impersonates a customer account, `exploring`.
- The service is configured per project with the expected issuer and its public JWK. There is no key discovery and no URL taken from the token.
- `POST /v1/auth/session` checks the signature, issuer, audience, dates, origin and deployment, consumes the token id once, and returns an opaque 256-bit bearer valid 5 minutes, stored as a hash. The browser keeps it in memory only.
- Capabilities are intersected with the project policy (`attestableCapabilities`). `thread.participate` allows publishing and replying. `thread.moderate` (the developer role) allows resolving and reopening any thread; authors can always resolve their own. A form field never grants a role.
- Every session request must carry the exact `Origin` of the session. Unregistered origins receive no CORS headers.

**Delegated agent tokens.** A coding agent acts in the name of a real person without any account outside the host. `npx @meyer0x/socrate login` starts a device authorization: the service returns a secret `deviceCode` kept by the tool and an 8-character `userCode` shown to the person. In a preview where they are signed in, the person types the code under **Connecter un agent**; the panel shows the agent, the machine and the project, and the person approves. The identity therefore comes only from the Socrate session of the panel, itself obtained from the host backend's assertion: the host has nothing to add, and no GitHub or other provider is involved.

- Approval freezes the real actor (never an impersonated account: approval is refused while `exploring`), the agent name and the capabilities of the session (`review.read`, `thread.participate`, `thread.moderate` if present), intersected with the project policy. The policy is checked again at every use.
- The token is 256 random bits, stored as a hash, valid 30 days without extension, for the whole project. It reads like `review.read`, replies, resolves and reopens with a mandatory message; it never creates a thread, a proposal or an attachment, nor archives, purges or imports.
- It is refused with any `Origin` header: it serves tools, never a page. Start and exchange refuse `Origin` too.
- Residual risk: a script injected in a preview can obtain a session through the host's identity bridge, as the panel does, then approve without any click a code started by an attacker. The attacker then holds a 30-day token on the project, limited to reading, replying, resolving and reopening, instead of a 5-minute session. The person sees it under **Mes agents**, with the agent name and the machine name, and revokes it there; its messages show "via" and the agent name.
- Messages written with it record `via` (the agent name); a resolution also records the commit and the latest non-revoked deployment of the review. The panel shows "Name · via Claude" and "Résolu dans abc1234".
- The person lists and revokes their agents in the panel; the tool revokes its own token with `npx @meyer0x/socrate logout`. Revocation takes effect at the next request. A restore revokes every delegated token.
- Unknown codes typed in the panel are limited per person and project (5 failures in 10 minutes), pending codes per project (20). See [ADR 0009](adr/0009-delegated-agent-tokens.md).

Each submission (comment, reply, state change) is an intention with an idempotency key, frozen with the identity displayed at click time. If the response is lost, the client keeps the intention and retries with the same key; if the identity changed meanwhile, the retry is blocked rather than replayed under another user. The reviewer can explicitly abandon a pending retry; the UI says the earlier submission may already be published. When the signed-in user changes in the same tab, the host remounts the client (`key` on the component, or unmount and mount again).

## Captures

- A targeted comment needs a fresh image of the tab. The client asks for tab capture (`getDisplayMedia` with the current tab preferred) only when the reviewer starts targeting, and stops the tracks when the reviewer closes Socrate.
- Socrate's own controls are hidden from the captured frame. The client checks that the frame is fresh before using it, and converts CSS coordinates to image coordinates.
- Publication is a three-step protocol: reserve an operation in D1, `PUT` the bytes to R2 under an operation-specific key, then commit. Only the commit makes the thread visible. Expired reservations are cleaned without ever deleting a committed capture.
- The target records the URL, the route (and the host route when the element is in a same-origin iframe), the frame path, the rectangle, the viewport, the role, the text, a selector and a sanitized HTML excerpt with a bounded ancestor context. Pins are relocated on later visits only when exactly one candidate matches; Socrate never picks the first of several matches.
- Messages can also carry up to four attachments: PNG, JPEG or WebP images up to 10 MiB, MP4 or WebM videos up to 50 MiB. Screen recordings in other formats are converted in the browser when possible.

## Isolation in the host page

- The client renders its UI in an `about:blank` iframe of the same origin, through a React portal, with its own styles and error boundary. A Socrate rendering error does not reach the host's React root, and host CSS does not leak in.
- The only permanent event interception is filtered to Socrate's own controls. Clicks on the host app are intercepted only while the reviewer is selecting a target.
- In production builds, the dynamic import, the styles, the manifest and the editorial attributes must disappear. The demo proves this on its build graph (`npm run measure:demo`).

## Data

D1 holds reviews, revisions, deployments, sessions, delegated agent tokens and pending device codes, threads, messages, proposals, targets, captures metadata, attachments metadata, idempotent operations and a change log. R2 holds screenshots and attachments. Migrations are numbered and checksummed; the Worker answers `503 not_ready` until its expected schema is applied and refuses a divergent schema with `schema_incompatible`.

The change log only says which threads changed; their values always come from the business tables. Each mutation writes its log entry in the same D1 batch.
