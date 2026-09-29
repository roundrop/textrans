# Textrans v2 architecture

## Product boundary

Two online browsers, one temporary session, explicit text/file handoffs. A file is limited to **10,000,000 bytes**, including a valid empty file. No account, server-side inbox, automatic clipboard monitoring, third participant, or persistent browser history.

## Hosting and transport

Svelte/TypeScript/Vite produces static assets. A Cloudflare Worker handles `/api/*`; other requests are served by Workers Static Assets without invoking the Worker. SQLite-backed Durable Objects are compatible with the Workers Free plan.

- **Directory** allocates six-digit invitations atomically using SQLite's unique primary key. Codes are cryptographically random with rejection sampling, expire in three minutes, and are consumed when a guest claims a room.
- **Room** has exactly two capability-authenticated roles, host and guest. Joining permanently binds the guest role. An invitation never becomes a public chat room.
- Browser sockets terminate using `acceptWebSocket` (the Hibernation API). `ping`/`pong` use the runtime auto-response, with no DO interval timers.
- WebSocket attachments retain role, rate counters and last activity across hibernation. SQLite retains token hashes, mode, expiration and disconnected-peer counters. Payloads are never stored.
- An alarm checks invitation expiration, the one-hour maximum and 15 minutes of application inactivity. Heartbeats do not extend the idle deadline.

## API

All API requests and WebSocket upgrades require an exact matching `Origin`. The endpoints expose no wildcard CORS. POST bodies are bounded at 1 KiB, including chunked bodies.

| Route                                | Behavior                                                                   |
| ------------------------------------ | -------------------------------------------------------------------------- |
| `POST /api/rooms` with `{}`          | Reserve a code, initialize a room, return the host capability              |
| `POST /api/join` with `{code, mode}` | Resolve an invitation and bind the guest capability once                   |
| `GET /api/rooms/:id/socket`          | WebSocket upgrade with protocols `textrans-v1` and an ephemeral capability |

Capabilities are random 256-bit values returned over HTTPS and kept only in page memory. Only hashes are stored by the room. Socket credentials are in the protocol header, not in URL query strings. Deployment observability is disabled to avoid request metadata accidentally becoming an application log. Platform-level metadata is outside this promise.

## Wire format

Before key confirmation, small JSON `commit` and `reveal` messages are relayed. After pairing, every control message and file chunk is an AES-GCM encrypted binary envelope. The server sees frame lengths, timing and connection metadata, but not text, file names, MIME types, offers, acceptance or acknowledgments.

Encrypted frame: version byte (1), big-endian 64-bit directional sequence, ciphertext with 128-bit GCM tag. See SECURITY.md for key establishment and nonce rules.

Decrypted envelopes:

- `0x00` followed by bounded UTF-8 JSON control data.
- `0x01` followed by a 36-byte UUID, big-endian uint32 chunk index and at most 32 KiB of file bytes.

The file protocol uses `offer → accept(next) → chunk/ack → finish(hash) → receipt`. One outstanding chunk provides backpressure. A file is never transferred before acceptance. The receiver checks exact chunk lengths, index, total size and SHA-256 before creating a download-only Blob. An empty file goes from acceptance directly to finish.

On a transient disconnection the sender retains the File reference, offset and hash; the receiver retains chunks and incremental hash in page memory. The same cryptographic session resumes using the role capability. Unacknowledged chunks and text are resent with new encryption sequence numbers and stable message IDs. Duplicates are acknowledged without re-appending. Delivery receipts, not socket send completion, drive the delivered state.

## Memory and data lifecycle

- Text: 64 KiB per message; at most five unacknowledged outgoing text messages.
- One outgoing file and one incoming file per browser at a time.
- Sender hashes the file incrementally, then reads slices for transfer. Receiver assembles at most a 10 MB file before creating a Blob.
- History: 20 entries; completed received file URLs have a combined 30 MB limit. Active transfers remain visible. Eviction and explicit session end revoke object URLs.
- Reload/navigation destroys keys, capabilities and transfer state. No localStorage/IndexedDB/service-worker content cache is used.
- Origin IP addresses are used for rate limiting, hashed with a rotating random daily salt before counters are stored. The salt and counters are periodically deleted. There are no analytics scripts, external fonts, link previews or server-side URL fetching.

## Free-plan guardrails

Current application limits, intentionally conservative defaults:

- New invitations: 12 per IP bucket / 10 minutes, 2,000 globally per UTC day.
- Invitation lookups: 20 per IP bucket / 10 minutes.
- Socket attempts: 120 per IP bucket / 10 minutes.
- Per role: at most 400 KiB per encrypted frame (including worst-case JSON escaping for 64 KiB text), 2 KiB per handshake frame, 2,500 messages and 25 MB per minute, 100 MB per session.

Client and receiver independently enforce the 10 MB file limit. The relay cannot inspect encrypted metadata, so it enforces frame/rate/session bounds instead. An attacker can still exhaust the provider's free quota and cause unavailability; application limits are not a DDoS guarantee.

The app intentionally uses no paid-plan-only resource or TURN/storage service. Keep the Cloudflare account on Workers Free to have provider-enforced quota failures instead of overage billing. Workers and DO requests, DO duration, reads and writes are separate quotas shared with other applications on the account. Test resource consumption on the actual deployment before estimating capacity.
