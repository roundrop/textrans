# UI and visual design

Textrans is a tool, not a landing page. The six-digit code, the QR code, and the verification numbers are what make it distinct, so they carry the visual identity. Accessibility rules (contrast, focus, touch targets, error wording) follow the [Digital Agency Design System](https://design.digital.go.jp/).

## Screen flow

- **Home:** One line states what the app does, then two panes. On desktop, "Connection code for this device" sits on the left and "Enter a code" on the right. On narrow screens the order flips: entering a code comes first, because a phone usually scans or types the code shown on a computer, not the other way round.
- **Invitation:** Creating a code keeps the home layout and replaces the button with the code in monospaced digits, the QR code, an expiry meter, and copy actions. The code works once and expires after three minutes. On narrow screens the QR code is collapsed behind "Show QR code", since another device rarely needs to scan a phone. Focus moves to the code when it appears. Pages are not pre-issued on load, because invitations count toward the Worker's per-IP and daily limits.
- **Verification:** Three groups of digits in separate boxes, with "They match" as the primary action. On narrow screens the decision is docked to the bottom of the viewport.
- **Connected:** A status line with a coloured dot and the End action sits above the workspace. On desktop, the composer (sticky) and the history sit side by side. On narrow screens the history comes first and the composer docks to the bottom. Incoming file requests are inserted at the top of the history with a dark left rule. Accepting a file moves focus to its progress and save controls; an incoming request alone never moves focus or scrolls the page.
- **Ending a session:** Ask for confirmation before clearing drafts, history, or transfers, only when any of them exist. Cancel or Escape returns to the previous interaction.

## Appearance

- **Colour:** Monochrome. Near-black ink on an off-white page, white surfaces, and grey lines. The primary button is ink-filled. Colour is reserved for state: green for connected and delivered, amber for verifying and reconnecting, red for errors and expiry. Dark mode swaps ink and ground and lightens the status colours.
- **Type:** Platform fonts only; the page fetches no fonts, images, or animation libraries. System sans for text, system monospace (`ui-monospace`, SF Mono, Menlo, Consolas) for codes, verification numbers, sizes, timestamps, and section labels, always with tabular figures.
- **Shape:** 6 px radius on controls and 10 px on panels, 1 px borders, no shadows. Sections are separated by rules rather than cards wherever possible.
- **Motion:** Short fades for new history entries and panels, a linear expiry meter, and a spinner while preparing. Nothing waits for an animation.

## Writing

- Headings name the state or the action: "Connected", "Enter a code", "Check that the numbers match".
- Buttons say exactly what happens: "Create code", "Connect", "Accept", "Save".
- Supporting text gives facts and numbers (limits, expiry, what is cleared) rather than adjectives.
- No slogans, poetic fragments, or parallel "this and that" phrasing. Japanese and English carry the same information.

## Accessibility

- Focus is a 2 px ink outline with a yellow ring, visible in both themes. The code boxes and the text editor show the same ring when focused.
- The six-digit field is a single native input (`inputmode="numeric"`, `autocomplete="one-time-code"`) layered over the visual boxes, so paste, autofill, and screen readers work as usual. Pasted full-width digits and whitespace are normalized. Invalid invitations show an inline error while preserving the input.
- Screen changes move focus to the heading. A native dialog handles focus containment and Escape for session-end confirmation. When unsent drafts or active file transfers exist, the app also uses the browser's leave-page confirmation where supported.
- Touch targets are at least 44 CSS pixels on coarse pointers. Typography uses rem units, and layouts wrap and stack at narrow widths and large text sizes.
- Reduced-motion preferences make transitions immediate. High-contrast preferences darken secondary text and borders. Forced-colours mode draws borders with system colours.
