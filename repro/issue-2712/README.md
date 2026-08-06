# Issue #2712 — User-actions footer wraps on narrow message bubbles

Reproduction for https://github.com/openchamber/openchamber/issues/2712

## Status: Reproduced

The hover-revealed `group/user-actions` footer (timestamp + Revert / Fork / Pin /
Copy buttons) below a user message does not stay on a single horizontal line when
the message bubble is narrow. The timestamp label "1:41 PM" wraps onto a second
line, the footer row grows from 24px to 40px tall, and the absolutely-positioned
footer overlaps the message content below it.

## Reproduction

```bash
# Requires google-chrome / chromium on PATH
node repro/issue-2712/measure.mjs
```

This renders `repro/issue-2712/fixture.html` in headless Chromium and measures
the footer geometry for a narrow bubble (one-word message, repro case) versus a
wide bubble (control).

### Measured output

| Metric | Narrow bubble (65px) | Wide bubble (400px) |
|---|---|---|
| Timestamp label text line boxes | **2** ("1:41" / "PM") | 1 |
| Footer action row height | **40px** | 24px |
| Footer row stays on one line | **no** | yes |
| Footer overlaps content below | **yes** | no |

The fixture inlines the real compiled Tailwind CSS (subset) produced by a
production `vite build` of `packages/web`, and replicates the exact footer DOM
from `packages/ui/src/components/chat/message/MessageBody.tsx`
(`UserMessageBody`'s `actionsBlock`, desktop inline mode).

## Root cause

In `MessageBody.tsx` the user-actions row is:

```tsx
<div className="group/user-actions absolute top-full left-0 right-0 z-10 pt-5">
  <div className="flex items-center justify-end gap-1 translate-x-5 ...">
    <span className="mr-1 flex items-center gap-1 text-sm tabular-nums ...">
      <Icon name="time" className="h-3.5 w-3.5" />
      <span className="message-footer__label">{timestamp}</span>
    </span>
    ...4 icon buttons (h-6 w-6, shrink-0)...
  </div>
</div>
```

Problems:

1. The outer `group/user-actions` div is `absolute top-full left-0 right-0` with
   no baseline width (the old `width: 229px` referenced in the issue is gone),
   so it shrinks to the bubble width.
2. The inner flex row has no `flex-nowrap` and the timestamp span + label have
   no `whitespace-nowrap`. The four icon buttons are `shrink-0` (from the
   `Button` base class) and `h-6 w-6`, so they cannot shrink; the timestamp
   span is the only shrinkable flex item and its text wraps onto two lines when
   the bubble is narrower than the combined control width.
3. Because the footer is absolutely positioned (`top-full`), the extra row
   height is not reserved in layout and the taller footer overlaps content below.

The threshold is ~230px of bubble width: below it the label wraps, at/above it
the row stays on one line (measured at 229px -> wraps, 235px -> single line).

## Why not a jsdom test

This is a CSS layout defect; jsdom does not perform layout. The reproduction
uses the app's real compiled CSS in a real browser engine (headless Chromium)
against the exact rendered DOM, which is the minimal faithful repro.
