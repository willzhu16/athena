# Cloudflare Workers target

For repos deploying to Cloudflare Workers/Pages. Loaded in addition to the stack layer.

## Runtime reality

- **The Workers runtime is not Node.** Do not use Node built-ins (`fs`, `path`, `net`,
  `child_process`, `process.env`) in request-path code. Use Web-standard APIs (`fetch`,
  `URL`, `crypto.subtle`, `Request`/`Response`) and Workers bindings. `nodejs_compat` is
  opt-in per binding, not a default to assume.
- CPU time per request is bounded (free tier). Keep handlers lean; no long-running loops,
  no synchronous heavy work. Long-running compute is out of scope for Workers (D-07).

## Bindings and config

- Resources (KV, D1, R2, queues) are declared in `wrangler.jsonc` and reached through the
  typed `env` binding — never hard-coded and never via global state. Run `wrangler types`
  and use the generated types; do not hand-write binding types.
- Do not edit `wrangler.jsonc` bindings unless the packet says so (10-security): binding
  and env changes are infrastructure, reviewed deliberately.

## Secrets and config

- Runtime secrets (third-party API keys) come from `wrangler secret` / the CF secrets
  store, exposed as bindings on `env`. Never read them from source, never log them, never
  put them in `wrangler.jsonc`. You get names, not values (10-security).
- Config that is not secret but wants versioning lives in SOPS-encrypted `secrets/*.env`
  (spec 06) — still never written by an agent.

## Observability and health (spec 08)

- Emit structured logs via the template's `src/lib/log.ts` (handbook log schema): one JSON
  object per line, `event` in snake_case, never log secrets or auth/billing request bodies.
- Keep `GET /healthz` cheap and dependency-free — it answers "is the Worker alive", not
  "is every binding happy". Do not add binding fan-out to it.

## Deploys

- You never deploy to production. Preview deploys (T2) use `wrangler versions upload`;
  production is tags-only via `release.yml` (spec 07), and the credentials for it are not
  in your environment.
