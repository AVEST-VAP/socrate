# 0005. Prove behaviour in the repository's own demo

Socrate is built and verified against its own demo application: fictional identities, Base UI modals, a same-origin iframe, and a local Workers/D1/R2 emulation. The hard constraints of real host apps (modals, split views, iframes, impersonation) are reproduced there with Socrate's own code.

Local proofs, checks of the browser's native capture picker, and proofs inside an integrating application are kept distinct. A proof that could not be run is reported as not run; it never becomes a success by approximation.
