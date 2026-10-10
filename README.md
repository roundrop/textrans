# Textrans

**A quick handoff.** Transfer text and small files between two open browsers.

- No account required. Connect with a QR code, an invitation link, or a six-digit code.
- End-to-end encryption. When connecting by numeric code, compare the verification numbers on both screens and confirm before sending.
- Send text in either direction, up to 64 KiB of UTF-8 per message.
- Transfer files of any type, up to **10 MB = 10,000,000 bytes** per file, with the recipient's approval.
- Delivery receipts, transfer progress, cancellation, and reconnection with retries after a temporary disconnection.
- Text, files, and decryption keys stay in browser memory. The relay does not persist payloads or keys.
- Japanese and English interfaces, mobile layouts, dark mode, and a home-screen manifest.

## Development

Requires Node.js 22.12 or later (24 LTS recommended) and pnpm 11.19.0.

```sh
corepack enable
pnpm install --frozen-lockfile
pnpm dev
```

Open `http://127.0.0.1:5173` in two browsers or windows. Development runs with local workerd and Durable Objects; no Cloudflare account is required.

```sh
pnpm check             # Type-check Svelte, browser code, and the Worker
pnpm test              # Unit tests for cryptography, the protocol, and the Worker
pnpm exec playwright install chromium webkit
pnpm test:e2e          # Build for production and test browser-to-browser transfers locally
pnpm build             # Production build of the client and Worker
pnpm preview           # Preview the production build locally
```

Dependency installation runs the `esbuild` and `workerd` build scripts, explicitly allowed in `pnpm-workspace.yaml`. Local state is stored in `.wrangler/`. Request limits also apply locally.

Use an HTTPS staging deployment to test on physical phones. Web Crypto is unavailable over ordinary LAN HTTP. Invitation links use the origin of the currently open site.

## Project structure

- `src/` — Svelte UI and browser-side connections, encryption, and transfers
- `shared/` — Protocol types, size limits, and incoming data validation
- `worker/` — Connection handling, invitation management, and encrypted message relay
- `tests/` / `e2e/` — Unit tests and browser-to-browser regression tests

## Documentation

- [Architecture](docs/ARCHITECTURE.md)
- [UI and visual design](docs/DESIGN.md)
- [Security design and limitations](docs/SECURITY.md)
- [Deployment and rollback](docs/DEPLOYMENT.md)

## Usage and limits

Keep both pages open during a session. Reloading or closing a tab loses the session; there is no offline delivery. A temporary disconnection preserves keys and transfer state in the same page so the connection can resume.

Invitations expire after three minutes. Sessions expire after 15 minutes of inactivity or one hour in total. History keeps the latest 20 entries; completed received files have a combined 30 MB limit, with the oldest released first. Data already copied or saved is unaffected. A delivery receipt means the other browser has received and verified the data, not that it has been saved to disk.

The current implementation uses a WebSocket relay. It has no WebRTC, TURN, cloud file storage, or HTTP polling fallback. The UI, transfer protocol, cryptography, and relay are separate so the transport can evolve independently.

## Legacy version

The `master` branch contains the current Cloudflare-based implementation. The previous Fly.io version is preserved on `textrans-v1` and at the `legacy-fly-v1` tag (`6566c46`), including its Express, Socket.IO, EJS, and Fly.io configuration files.
