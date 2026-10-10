# Deployment and rollback

## Hosted instance

[Textrans](https://textrans-v2.roundrop.workers.dev/) runs on Cloudflare Workers and Durable Objects.

## Automatic deployment from GitHub

The [GitHub Actions workflow](../.github/workflows/ci.yml) checks every pull request and push to `master`. A successful `master` push then deploys to the `textrans-v2` Worker. Failed or canceled checks and pull requests do not deploy.

The checks include formatting, type checking, unit tests, and Chromium/WebKit browser tests against the production build. The deployment job downloads that tested build and deploys it without rebuilding. Each Worker version is tagged with the Git commit SHA. Runs for the same Git ref are serialized so deployments do not overlap; a new push does not interrupt an active deployment. GitHub keeps only the latest pending run for that ref.

Before enabling automatic deployment, add these repository secrets under **Settings → Secrets and variables → Actions**:

- `CLOUDFLARE_API_TOKEN`: An account-owned Cloudflare API token with **Individual Workers → Editor** access only to **`textrans-v2`**.
- `CLOUDFLARE_ACCOUNT_ID`: The ID of that Cloudflare account.

Create a custom account-owned token under **Manage Account → API Tokens**:

1. Set the policy scope to **Specified Workers** and select **`textrans-v2`**.
2. Select only **Individual Workers → Editor**.
3. Remove inherited permissions such as **Workers Routes Write**, and remove any **Entire Account** policies supplied by a template.
4. Check that the summary contains only the intended Worker and Editor permission before creating the token.

Policies grant access cumulatively: adding a Worker-specific policy does not restrict a separate account-wide policy. This deployment changes no zone routes or custom domains, so it needs no zone permissions. The Worker's Durable Objects inherit its permissions. See [Workers roles and scopes](https://developers.cloudflare.com/workers/authorization/workers/) and [granular Wrangler authentication](https://developers.cloudflare.com/workers/authorization/#use-granular-permissions-with-wrangler).

The workflow passes these credentials only to the deployment step. Missing secrets cause that step to fail with a setup message. Local `wrangler login` credentials are not available on GitHub runners.

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
