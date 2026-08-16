# bridge/ — build output, not source

The bridge's source is `src/bridge/`. This folder holds what the build produces
and what an operator copies to the ERP server; everything in it except this file
is git-ignored.

```
pnpm bridge:build         # esbuild → bridge/dist/dada-bridge.js (one file, ~3 MB)
pnpm bridge:build:check    # node bridge/dist/dada-bridge.js --help
```

`dada-bridge.js` is deliberately self-contained: `mssql` and its driver are
bundled in, so the ERP server needs Node LTS and nothing else — no `npm install`,
no `node_modules`, no repository. Copy the single file.

On the server it lives in `C:\dada\bridge\`, and everything it reads or writes
sits **beside it**, never in the working directory (Task Scheduler starts jobs in
`C:\Windows\System32`):

| file | what it is |
| --- | --- |
| `bridge.env` | configuration and the two secrets — never committed, never logged |
| `bridge.log` | append-only run log, one event per line |
| `<command>.lock` | the singleton for a running command; stale after 30 minutes |

Commands: `orders`, `albaran-sync`, `price-sync`, `--help`. Deployment,
scheduling and the cutover checklist are in `docs/bridge-runbook.md` (Task 3).
