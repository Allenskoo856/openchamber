/**
 * Reproduction test for issue #2524.
 *
 * The gradient fade-out mask at the top of the sticky user header
 * uses `z-0` inside a stacking context created by the parent
 * sticky header (`z-20` + `relative`). Because of this stacking
 * context, the gradient renders ABOVE assistant message content
 * that appears after the header in the DOM, even though the
 * gradient has `z-0`.
 *
 * The gradient goes from opaque (matching the surface background)
 * to transparent, creating a solid color band that masks the first
 * 16–32px of assistant text content.
 */
import React from 'react';
import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';

import TurnItem from '../TurnItem';
import type { Turn, ChatMessageEntry } from '../../lib/turns/types';

function makeMessageEntry(id: string): ChatMessageEntry {
    return {
        info: { id, role: 'user' } as ChatMessageEntry['info'],
        parts: [],
    };
}

function makeTurn(overrides?: Partial<Turn>): Turn {
    return {
        turnId: `turn-${idCounter++}`,
        userMessage: makeMessageEntry('user-msg-1'),
        assistantMessages: [makeMessageEntry('assistant-msg-1')],
        ...overrides,
    };
}

let idCounter = 1;

describe('Issue #2524 — Gradient mask overlap', () => {
    test('gradient mask has z-0 inside sticky header stacking context (z-20)', () => {
        const turn = makeTurn();
        const html = renderToStaticMarkup(
            <TurnItem
                turn={turn}
                stickyUserHeader
                renderMessage={(m) => <div data-test-message>{m.info.id}</div>}
            />,
        );

        // The gradient mask should exist
        expect(html).toContain('bg-gradient-to-b');

        // Extract the gradient mask div (the div that has bg-gradient-to-b)
        const gradientMatch = html.match(
            /<div[^>]*aria-hidden="true"[^>]*bg-gradient-to-b[^>]*>/,
        );
        expect(gradientMatch).not.toBeNull();

        const gradientHtml = gradientMatch![0];

        // The gradient uses absolute positioning with top-full
        expect(gradientHtml).toContain('absolute');
        expect(gradientHtml).toContain('top-full');
        expect(gradientHtml).toContain('inset-x-0');

        // The gradient has z-0 — this is the bug: within the sticky header's
        // stacking context (z-20), the z-0 gradient renders at the bottom of
        // THAT stacking context, but since the stacking context has z-index 20,
        // the gradient still renders ABOVE content in the root stacking context
        // (like the TurnAssistantBlock)
        expect(gradientHtml).toContain('z-0');

        // The gradient goes from opaque background to transparent
        // When it overlaps with text, the opaque portion completely hides the text
        expect(gradientHtml).toContain('from-[var(--surface-background)]');
        expect(gradientHtml).toContain('to-transparent');

        // Verify the sticky header has z-20 (creates a stacking context)
        // TurnItem renders: sticky top-0 z-20 relative
        const stickyHeaderMatch = html.match(/sticky[^"]*top-0[^"]*z-20/);
        expect(stickyHeaderMatch).not.toBeNull();

        // The assistant messages are rendered AFTER the sticky header div
        // in a sibling element (TurnAssistantBlock), which wraps them in a
        // div with `relative z-0`. This creates ANOTHER stacking context at
        // z-index 0 in the root context. But the gradient is inside the
        // sticky header's z-20 stacking context, so it paints ABOVE the
        // assistant content.
        const assistantHtml = html.match(/assistant-msg-1/);
        expect(assistantHtml).not.toBeNull();
    });

    test('assistant message content appears after the gradient mask in DOM order', () => {
        const turn = makeTurn({
            assistantMessages: [
                makeMessageEntry('assistant-msg-2'),
                makeMessageEntry('assistant-msg-3'),
            ],
        });

        const html = renderToStaticMarkup(
            <TurnItem
                turn={turn}
                stickyUserHeader
                renderMessage={(m) => m.info.id}
            />,
        );

        // The gradient should appear before the messages in DOM order
        const gradientIndex = html.indexOf('bg-gradient-to-b');
        const assistant2Index = html.indexOf('assistant-msg-2');
        const assistant3Index = html.indexOf('assistant-msg-3');

        expect(gradientIndex).not.toBe(-1);
        expect(assistant2Index).not.toBe(-1);
        expect(assistant3Index).not.toBe(-1);

        // Gradient appears BEFORE assistant messages in DOM order
        expect(gradientIndex).toBeLessThan(assistant2Index);
        expect(gradientIndex).toBeLessThan(assistant3Index);
    });

    test('non-sticky mode does not have the gradient mask', () => {
        const turn = makeTurn();
        const html = renderToStaticMarkup(
            <TurnItem
                turn={turn}
                stickyUserHeader={false}
                renderMessage={(m) => m.info.id}
            />,
        );

        // When stickyUserHeader is false, the gradient mask is not rendered
        expect(html).not.toContain('bg-gradient-to-b');
    });
});
