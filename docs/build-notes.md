# Build notes

How the first version was checked (October 2026), and a few lessons from building it. Not needed to run the tool.

## Real-store check (live, 2026-10-20)

Run by hand with the CLI. Both stores loaded, all 13 checks ran, 10 requests each.

| Store | Platform | Score | Notes |
|---|---|---|---|
| www.allbirds.com | Shopify | 98 | 1 of 3 product pages had a short description |
| kith.com | Shopify | 100 | everything passed |

The Shopify path was seen working on real stores. No real WooCommerce store was scanned yet; the WooCommerce path is covered by tests with hand-written sample stores only.

## Review

The code had several rounds of independent adversarial review. Each issue found was fixed together with a regression test.

## What you can learn from this

1. **Check the address at connect time, not before.** Looking up a name, checking it, and then connecting lets a tricky DNS server swap the answer in between. Passing our own `lookup` to Node's request means the exact IP we connect to is the one we checked. See `src/safe-fetch.js`.
2. **IPv6 hides IPv4 inside it.** `::ffff:127.0.0.1`, NAT64 (including the local-use `64:ff9b:1::/48` range), 6to4 and Teredo addresses all wrap an IPv4 address, so a block list that only knows IPv4 ranges can be bypassed. See `src/safe-fetch.js`.
3. **Firewalls look at how you connect, not just who you say you are.** Real Shopify stores answered our first version with 429 "too many requests" while `curl` got in. The difference was that Node's plain HTTPS client did not offer ALPN; one option fixed it. See `src/safe-fetch.js`.
4. **robots.txt has real rules, and robots.txt is hostile input.** The most specific group wins, then the longest matching path, and Allow wins a tie (`src/robots.js`). Turning `*` into a regular expression let a crafted file freeze the server for 20 seconds, so the matcher splits on `*` and uses `indexOf`, with no backtracking (`src/robots.js`).
5. **You may not need Playwright.** Chrome speaks the DevTools Protocol over a WebSocket, and Node 22 has WebSocket built in, so a short driver can type, click, resize to a phone and take screenshots. See `tests/helpers/cdp.js`.
