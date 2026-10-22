# 0002. Separate the review from its deployments

A review has a stable identity and several immutable deployments and revisions. Each thread keeps the context of its creation. A preview URL or a `pr-<n>` tag is not enough to represent a version: the same tag may be reused across pushes, and the URL may change. A redeployment neither erases nor resolves feedback; a target that can no longer be found stays explained by its original screenshot.
