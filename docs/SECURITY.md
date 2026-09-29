# Security design and review status

This is an application-level E2EE implementation built with browser Web Crypto primitives. It is **not an independently audited cryptographic protocol** and must not be described as one. Automated tests exercise important invariants but do not establish a formal security proof. Review the pairing protocol before a broad public release.

## Threat model

Protect content from passive observation by the relay and from a network attacker under HTTPS. Prevent an unauthenticated third browser from joining a bound two-person room. Detect corrupted/substituted payloads. A six-digit invitation is a locator, not an encryption key or a sufficient identity proof.

The hosting provider/operator controls the delivered JavaScript. Malicious or compromised page code, browser extensions, the operating system, and a person with the invite secret or access to the other screen can obtain data. Browser-based E2EE cannot remove these trust assumptions. The relay learns IP addresses, connection times, frame sizes and traffic patterns. Do not claim anonymity or zero metadata.

## Key establishment

Each browser creates a fresh non-exportable P-256 ECDH private key and a 256-bit random nonce. Public keys use the raw uncompressed encoding. A commitment is SHA-256 of a canonical JSON array:

`["textrans-pair-v1", roomId, mode, role, publicKeyBase64url, nonceBase64url]`

Both sides send commitments before sending reveals. A peer's reveal is accepted only after receiving its commitment; the role, room, mode, key and nonce must match the commitment. The nonce prevents brute-force selection against a reveal while only its commitment is available. Changed commitments/reveals are rejected, including across reconnects.

Two verification paths:

1. **QR/link:** The host generates a separate 256-bit shared secret in the URL fragment. Each reveal includes HMAC-SHA-256(secret, own canonical material). Both peers verify the proof. The fragment is removed from the browser address bar using `replaceState` before joining; it is never included in API requests. The QR is generated locally. Sharing the link gives its recipient the ability to join.
2. **Code:** There is no secret in the numeric invitation. Both screens display three groups of four digits derived from the shared key and full transcript. Users must compare _all three groups_ and confirm on both ends. An unnoticed mismatch defeats this protection. Commit-before-reveal and transcript binding follow the SAS verification design principle used by Matrix; this is not Matrix wire compatibility or a claim to inherit its audit.

The complete host material followed by guest material is serialized as a JSON array and hashed into the transcript salt. HKDF-SHA-256 over the ECDH secret derives independent 256-bit host-to-guest and guest-to-host AES-GCM keys, plus a distinct SAS value. Versioned info strings domain-separate each purpose. The SAS has 39 bits (three independently extracted 13-bit groups, each displayed as 1000–9191).

Each side sends an encrypted `verified` control message. File/text envelopes are accepted only after local verification and receipt of the peer's encrypted verification. QR verification is automatic; code verification requires human interaction. The guest pins its locally selected mode, and a mode change after handshake initialization is an error. A hostile relay cannot silently downgrade QR authentication into automatic code approval.

## Encryption, replay and retries

- AES-256-GCM with its full 128-bit tag.
- Each direction uses a distinct key. Its 96-bit nonce is 32 zero bits plus an incrementing 64-bit counter starting at one. Nonces are never reused under a key.
- The transcript hash and version/sequence header are additional authenticated data.
- Encryption operations are serialized. Reconnecting retains the same in-memory channel and counters. Reloading creates a new invitation/key, never resets counters on an existing key.
- Receivers authenticate before advancing their receive sequence. Already accepted/older sequences are discarded. Application-level resends use a fresh encrypted frame and the same transfer/message ID.
- The file SHA-256 verifies complete assembly. Per-frame AEAD and authenticated offsets/size/finish messages enforce order, completeness and identity; an unkeyed file hash alone is not the security boundary.

## Application protections

- Cryptographic randomness for codes, tokens, keys and IDs.
- Origin checks, one-use invitations, exactly two roles, expiring capabilities, rate and aggregate transfer limits.
- Plain-text rendering of incoming text. Only whole `http:`/`https:` URLs get a user-clicked link; links use `noopener noreferrer`.
- Received files are download-only `application/octet-stream` Blobs. HTML/SVG is never embedded or executed. File name/type/size are untrusted. Transfer does not certify a file as malware-free.
- No third-party page scripts, fonts, analytics, secret-bearing query strings or server-side preview fetches.
- Production CSP restricts script/connect sources to self, forbids framing and objects. The development server necessarily uses its own HMR resources; verify the built deployment's headers separately.
- No payload or key persistence/logging. Connection metadata uses short-lived DO storage; provider backups/metadata retention may outlive logical deletion. No forensic erasure guarantee.

## References

- [Web Crypto API](https://www.w3.org/TR/WebCryptoAPI/)
- [Matrix SAS verification](https://spec.matrix.org/latest/client-server-api/#short-authentication-string-sas-verification)
- [HKDF, RFC 5869](https://www.rfc-editor.org/rfc/rfc5869)
- [noble-hashes](https://github.com/paulmillr/noble-hashes) for incremental SHA-256; dependency lockfile pins the implementation.
