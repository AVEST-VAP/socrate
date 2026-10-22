# Security policy

Please report vulnerabilities privately, through GitHub: open the repository's **Security** tab and choose **Report a vulnerability**. Do not open a public issue, pull request or discussion for a security problem.

Include what you can: affected version or commit, the component (Worker, client, local tooling), steps to reproduce, and the impact you expect. You should get a first answer within a week.

Areas that matter most:

- identity assertions and session exchange (`apps/service/src/auth.ts`);
- origin checks, CORS and the served client module;
- technical tokens and their capabilities;
- isolation of the client inside host pages;
- captures and attachments (validation, storage, access).

The local tooling under `tools/local` guards paths and network access for test runs, but it is not a sandbox and does not defend against a hostile process running as the same user.
