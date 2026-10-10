# UI and visual design

The interface focuses on a quick handoff: clear actions, immediate feedback, and readable content.

## Screen flow

- **Before connecting:** A central card brings together session creation and code entry. A small vector illustration shows the handoff between devices, with a brief description and one primary button to get started.
- **Invitation:** The QR code takes priority, with a six-digit code and invitation link as alternatives. Expiration information and copy actions appear together.
- **Verification:** Three groups of numbers appear in separate boxes for easy comparison between screens. The interface also shows when the other participant's confirmation is pending.
- **Connected:** On desktop, the composer and history sit side by side. On mobile, they form a single column, with incoming requests above the composer. Accepting a file moves focus to its progress and save controls. An incoming request alone does not move focus or scroll the page.
- **Ending a session:** Ask for confirmation before clearing drafts, history, or transfers, only when any of them exist. Cancel or Escape returns to the previous interaction.

## Appearance and interaction

The default palette uses a soft neutral background, white content surfaces, and blue primary actions. Shared CSS variables define spacing, corner radii, borders, and shadows. Dark mode adjusts backgrounds, surfaces, text, and status colors.

System fonts provide distinct heading and body weights, line heights, and letter spacing. Icons and device illustrations are local SVG assets. The page does not fetch external fonts, images, or animation libraries.

The selected segment's background moves from its current position using a Svelte spring. Presses respond immediately, while screens and incoming cards appear with short fades. Interactions do not wait for animations to finish.

Copy actions show a check mark and result on the button and announce the result to screen readers. Code entry normalizes pasted full-width digits and whitespace. Invalid invitations show an inline error while preserving the input for correction. Text limits remain visible while typing. Dropping multiple files displays guidance to send one at a time.

## Accessibility

Arrow, Home, and End keys select segments; Tab moves to the next control. Screen changes move focus to the heading, and accepting a transfer moves focus to that file. A native dialog handles focus containment and Escape for session-end confirmation. When unsent drafts or active file transfers exist, the app also uses the browser's leave-page confirmation where supported.

Typography uses rem units, and narrow layouts allow wrapping and vertical stacking. Primary touch targets are at least 44 CSS pixels. Reduced-motion preferences make spring transitions immediate and remove animated scrolling and press movement. Reduced-transparency preferences make the header opaque. High-contrast preferences strengthen text and borders.
