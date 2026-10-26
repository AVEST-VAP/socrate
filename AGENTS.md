# Socrate: notes for coding agents

Socrate lets reviewers comment inside preview deployments and lets agents read that feedback through an API. Start with [README.md](README.md), then [docs/how-it-works.md](docs/how-it-works.md) for the glossary and the life of a review.

## Before changing code

- Follow [CONTRIBUTING.md](CONTRIBUTING.md): export the local variables, keep every file under `.local/` and `.tmp/`, and run commands through the npm scripts so they cross the `tools/local/local-run.ts` boundary.
- Read the ADR in `docs/adr/` that owns the area you touch. A change of contract needs a new or updated ADR.
- Never remove one of the thirteen `skip` markers (`retenu, fermeture à borner`) without making that test's cleanup bounded.

## Verifying a change

- `npm run verify` runs typecheck, contract and browser suites. `npm run measure:demo` checks the production build and the size budget.
- `.agents/skills/verify-socrate/` drives the demo like a reviewer and writes evidence under `.local/artifacts/`. Read its `SKILL.md` before using it.
- Prove behaviour through the real path: host sign-in, Socrate UI, then a second read through the agent API or D1. Do not insert rows directly or mock the service.

## Reading feedback as an agent

Use the `socrate` CLI (`npx @meyer0x/socrate`) after `npx @meyer0x/socrate login` ([packages/socrate/README.md](packages/socrate/README.md#for-coding-agents)), or [docs/agent-api.md](docs/agent-api.md) with a `review.read` token for automation without a person. To prepare a review for product people, write a `.socrate/` manifest as described in [docs/integrate.md](docs/integrate.md#the-socrate-manifest).
