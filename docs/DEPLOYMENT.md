# Deployment and rollback

## Hosted instance

[Textrans](https://textrans-v2.roundrop.workers.dev/) runs on Cloudflare Workers and Durable Objects.

## Before publishing

1. Run `pnpm format:check`, `pnpm check`, `pnpm test`, and `pnpm test:e2e` (includes the production build). Stop any development server on port 5173 first so Playwright tests the production preview. The browser tests cover Chromium and WebKit; see the [development setup](../README.md#development) for browser installation.
2. Review [the security design](SECURITY.md), especially code-mode SAS and QR authentication. Automated checks do not replace a cryptographic design review.
3. Verify on physical iOS Safari and Android Chrome: standard-camera QR link, copying text, receiving/saving a 10 MB file, cancel, screen lock/unlock, and switching Wi-Fi/mobile data. Playwright WebKit is useful but is not an iOS device.
4. Confirm the Cloudflare account uses **Workers Free** and has SQLite Durable Objects available. Other applications share its quotas. Do not enable a paid plan just to resolve a deployment error.

## Preview deployment

The Worker name defaults to `textrans-v2`; it does not modify Fly.io or existing DNS.

```sh
pnpm exec wrangler login
pnpm exec wrangler whoami
pnpm deploy
```

The Cloudflare Vite plugin emits the deployment configuration in `dist/textrans_v2/wrangler.json` and records it for Wrangler in `.wrangler/deploy/config.json`. The top-level config defines the Worker entry, asset routing and SQLite DO migration.

Use the resulting `workers.dev` HTTPS URL first. Check QR on actual devices, no external page requests, API origin rejection, pairing/expiry, WebSocket hibernation and free-quota consumption. Confirm HTML responses include the CSP, `Referrer-Policy: no-referrer`, `X-Content-Type-Options: nosniff`, and no-framing headers from `public/_headers`. A strict-CSP preview must work with no console violations.

Application logs are disabled. Do not enable body/header logging while diagnosing real transfers. Use synthetic data in staging. The built UI remains statically available when dynamic APIs hit a free quota, but APIs may fail with Cloudflare's own error response; the client treats unreadable API errors as temporary unavailability.

## Cutover

- Record the current production domain/DNS and Fly.io deployment before changing either.
- Deploy the verified revision from `master`.
- Add the existing domain as a Worker custom domain only when ready to route users to the new version.
- An existing legacy Socket.IO session cannot migrate into v2; users open a fresh session.
- Keep the old Fly.io deployment available through the initial verification window, then stop/remove it after successful cutover.

## Rollback

For a v2 regression, use Cloudflare deployment rollback to a previously verified Worker version. Record the deployment version ID after each release. Replacing a Worker can interrupt WebSockets; clients reconnect, but a tab reload loses in-memory keys and payloads.

If a legacy cutover must be reversed, restore the domain routing to the recorded Fly.io destination. The old source and infrastructure files remain on `textrans-v1` and at `legacy-fly-v1` (`6566c46`). To inspect them without overwriting current work:

```sh
git worktree add ../textrans-legacy legacy-fly-v1
```

The legacy Node.js 9 stack is retained as a rollback reference, not a long-term supported deployment. A source tag alone does not guarantee a future rebuild of an obsolete runtime; keeping the existing deployment is preferable during cutover.
