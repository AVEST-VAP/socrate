# 0001. A service independent of previews and of the host app

Socrate owns a shared service and a client module, in a standalone repository. Previews disappear and are redeployed while feedback must stay readable, so the data cannot belong to the lifecycle of a preview server. The integrating application provides navigation and a verifiable identity; the product does not depend on any package of that application. This boundary is what makes Socrate usable by any web app.
