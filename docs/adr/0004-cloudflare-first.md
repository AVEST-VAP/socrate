# 0004. Cloudflare first, portability later

The reference installation is Cloudflare Workers, D1 and R2. Building and verifying two runtimes from the start (for example Cloudflare plus Docker, Node, SQLite and files) would add work that the first integration does not need. A more general self-hosting story remains a goal; no universal adapter layer and no migration between hosts is required for now. Business rules stay separate from storage access, without anticipating a second driver.

Local runs use the real Worker under Miniflare with local D1 and R2. They do not prove a remote deployment, which stays under the operator's control. Backup and restore of the chosen installation are still required.
