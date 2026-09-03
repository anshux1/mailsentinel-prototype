# oRPC query and polling contract

- Set `x-organization-id` on every tenant request; the server validates membership and never chooses an organization implicitly.
- After `analysis.start` or `analysis.retry`, invalidate the matching `analysis.list` page and begin polling `analysis.getStatus`.
- Poll active states (`accepted`, `queued`, `processing`) every 2–5 seconds with exponential backoff and pause while the page is hidden.
- Stop polling on `completed`, `failed`, or `deferred`. On `completed`, invalidate and fetch `analysis.getResult`; `ready: false` is the typed response for non-completed runs.
- Invalidate `case.list` after `case.create`, `evidence.list` after upload completion, and `report.list` after report generation.
- List procedures are ordered by `createdAt DESC, id DESC`. Pass the opaque `nextCursor` returned by a page; do not construct or inspect cursors in clients.
- Result responses contain forensic observations only. Raw email bodies, object keys, credentials, and executable HTML are not part of the browser contract.
