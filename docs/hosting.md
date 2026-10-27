# Hosting

Nothing is deployed. This page explains the recommended host and how to turn it on.

## Pick: Render (one Node web service), with `render.yaml`

| Option | Fit | Why / why not |
|---|---|---|
| **Render web service (picked)** | Runs `npm start` as is | Managed Node, HTTPS, health checks, no server to patch. Free plan sleeps when idle (first scan after a pause waits for a cold start); the $7/month plan stays awake. Config lives in `render.yaml`. |
| Cloudflare Pages + Functions / Workers | Static page fits; the scanner does not | The scan must run on a server (browsers block reading other sites, CORS). Workers could do that, but the scanner's private-network guard (`src/safe-fetch.js`) relies on Node's connect-time DNS check, which Workers' `fetch` does not expose. Porting would mean rewriting the most security-sensitive, already-reviewed code. |
| Google Cloud Run / Fly.io | Would work | Needs a Dockerfile plus cloud credentials in CI. More moving parts than Render for one small service. |
| Static-only (GitHub Pages) | Does not work | No server, so no scan. |

## How to turn it on

1. In Render: New, Blueprint, pick this repo. Render reads `render.yaml`.
2. Click Manual Deploy. `autoDeploy` is off in `render.yaml`, so pushes and merges never deploy by themselves.

`TRUST_PROXY_HOPS=1` is already set in `render.yaml` so the per-visitor rate limits see the visitor, not Render's proxy.
