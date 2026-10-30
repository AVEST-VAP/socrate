# 0012. Handing a thread to an agent with a word

Within ADR 0009. Usage: [agent-api.md](../agent-api.md#handing-a-thread-to-the-agent).

## Context

In a real review, 9 of the 11 replies of the developer were instructions for their agent, one mixed a question for the reviewer with a fix, and one postponed the work. Nothing told them apart, so the agent had to guess, and a later reply could contradict an earlier instruction.

## Decision

- **`@agent` is a word in the message body.** It triggers nothing. The person starts the agent; the agent runs `threads --for-agent`.
- **The state is derived from the messages**, by one pure function shared by the CLI and the panel: `pending`, `answered` or `superseded`. No column, no migration, no service change.
- **Only the signed-in person's instructions count.** The token holder's own `@agent` messages, never a reviewer's: thread text is untrusted input, and anyone able to comment would otherwise be able to drive the developer's agent.
- **A person's message after the instruction cancels it**, whoever wrote it, even after the agent answered. The agent reads the conversation again rather than act on a stale decision.
- **`--after <seq>` guards the write** from the CLI.

## Limits

- The marker is text: a person can quote `@agent` without meaning it. The tag in the panel shows the effect at once, and the cost is one thread listed.
- `--after` reads then writes, so a message posted between the two is missed. Closing the race needs a service-side precondition.
- The agent still cannot tell one instruction from another within a message. Sorting them is its job.

## Rejected alternatives

- **A mention that starts the agent.** Socrate runs no agent, and a comment must never execute anything.
- **A menu of instruction types (fix, investigate, propose).** "À investiguer" already says it, and a click in every reply slows the review.
- **A `handoff` column.** It adds a migration and a Worker deployment for a value the messages already determine.

## Consequences

No change of contract on the wire, and no Worker deployment for the CLI. A panel served by the Worker gets the filter at its next deployment.
