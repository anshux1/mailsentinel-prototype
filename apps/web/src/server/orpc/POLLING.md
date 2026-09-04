# oRPC query and polling contract

- Set `x-organization-id` on every tenant request; the server validates membership and never chooses an organization implicitly.
- After `analysis.start` or `analysis.retry`, invalidate the matching `analysis.list` page and begin polling `analysis.getStatus`.
- Poll active states (`accepted`, `queued`, `processing`) every 2–5 seconds with exponential backoff and pause while the page is hidden.
- Stop polling on `completed`, `failed`, or `deferred`. On `completed`, invalidate and fetch `analysis.getResult`; `ready: false` is the typed response for non-completed runs.
- Invalidate `case.list` after `case.create`, `evidence.list` after upload completion, and `report.list` after report generation.
- Every upload also produces an ingestion batch, so invalidate `batch.list` alongside `evidence.list` after `evidence.completeUpload`.
- Poll `batch.list` / `batch.get` only while a batch is `pending` or `segmenting`; stop on `ready`, `partial`, or `failed`. `partial` is terminal and means some children failed while the rest are usable.
- Read the children of a batch with `evidence.listByBatch`, not `evidence.list`: only the former attaches the analyzer-extracted `summary` (from / subject / date) that distinguishes segmented messages.
- `mailbox.startSync` runs inside the request and returns the batch it produced. Invalidate `mailbox.list`, `batch.list`, and `evidence.list` on completion; poll `mailbox.list` while any connection is `syncing`.
- When `MAILBOX_CONNECTORS_ENABLED` is false, every mailbox procedure rejects with `FORBIDDEN` and `data.code = "MAILBOX_CONNECTORS_DISABLED"`. That is a deployment configuration state — do not retry it, and present it as an explanation rather than an error.
- The Gmail OAuth handshake is a browser redirect (`/api/mailbox/gmail/start`), not an RPC call. The callback returns to `/settings` with `mailbox_connected=true` or `error=<code>`; announce the result once and strip the parameter.
- Evidence `summary` fields are header-derived text from a hostile source. Render them as plain text only — never as markup, and never as the href of a link.
- List procedures are ordered by `createdAt DESC, id DESC`. Pass the opaque `nextCursor` returned by a page; do not construct or inspect cursors in clients.
- Result responses contain forensic observations only. Raw email bodies, object keys, credentials, and executable HTML are not part of the browser contract.
