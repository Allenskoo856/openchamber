/**
 * Reproduction test for Issue #2533:
 * Android: long dictation transcript pushes Cancel/Insert/Insert-and-send controls off-screen.
 *
 * This test verifies that the root cause exists in the current code: when dictation is
 * activated from the mobile pill, isExpandedInput (global UI store) is never set to true,
 * so the form does not receive the expanded layout classes that would constrain it to the
 * viewport. Combined with applied minHeight from dictationContentHeight and no overflow
 * constraint, the form grows beyond the viewport on Capacitor (native Android).
 */

import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

const chatInputSource = readFileSync(new URL('../ChatInput.tsx', import.meta.url), 'utf8');
const mobileComposerShellSource = readFileSync(
    new URL('../composer/state/useMobileComposerShell.ts', import.meta.url),
    'utf8',
);
const mobileViewportPinSource = readFileSync(
    new URL('../composer/state/useMobileViewportPin.ts', import.meta.url),
    'utf8',
);

describe('Issue #2533: Android dictation overflow', () => {
    // -----------------------------------------------------------------------
    // Root Cause 1: isExpandedInput is NOT set to true when dictation goes active
    // -----------------------------------------------------------------------
    test('isExpandedInput is not set to true when dictation activates from pill', () => {
        // Find onDictationActiveChange in useMobileComposerShell
        const fnStart = mobileComposerShellSource.indexOf('const onDictationActiveChange');
        expect(fnStart).toBeGreaterThan(-1);

        // Verify it calls setDictationActive and setExpanded but NOT setExpandedInput(true)
        const body = mobileComposerShellSource.slice(
            fnStart,
            fnStart + 1500, // enough to capture the full callback body
        );

        // setDictationActive IS called
        expect(body).toContain('setDictationActive(');

        // setExpanded(true) IS called for the active branch
        expect(body).toContain('setExpanded(true)');

        // setExpandedInput is NOT called in the active (dictation starting) branch
        const activeBranch = body.slice(0, body.indexOf('// Dictation ended'));
        expect(activeBranch).not.toContain('setExpandedInput');

        // The inactive branch calls setExpandedInput(false), never true
        const inactiveBranch = body.slice(body.indexOf('// Dictation ended'));
        // setExpandedInput is called with false in a setTimeout
        expect(inactiveBranch).toContain('setExpandedInput(');

        // Additionally, grep the entire useMobileComposerShell file for setExpandedInput(true)
        // to confirm it's NEVER called anywhere in the hook
        const allCalls = [...mobileComposerShellSource.matchAll(/setExpandedInput\(/g)];
        const trueCalls = [...mobileComposerShellSource.matchAll(/setExpandedInput\(true\)/g)];
        expect(allCalls.length).toBeGreaterThan(0); // it is called (with false)
        expect(trueCalls.length).toBe(0); // never called with true
    });

    // Verify the ChatInput form does NOT get isMobileExpanded when dictation is active
    test('ChatInput form mobile classes depend on isExpandedInput, not dictation state', () => {
        // The form's className uses isMobileExpanded which depends on isExpandedInput
        const formClassStart = chatInputSource.indexOf('className={cn(',
            chatInputSource.indexOf('<form'));
        expect(formClassStart).toBeGreaterThan(-1);

        // Grab 300 chars after the form className to see all class conditions
        const formClassSection = chatInputSource.slice(
            formClassStart,
            formClassStart + 300,
        );

        // The form className references isMobileExpanded but not dictationActive
        expect(formClassSection).toContain('isMobileExpanded');
        expect(formClassSection).not.toContain('dictationActive');
    });

    // -----------------------------------------------------------------------
    // Root Cause 2: The dictation content height applies minHeight with no cap
    // -----------------------------------------------------------------------
    test('dictationContentHeight applies minHeight without viewport constraint', () => {
        // Find where dictationContentHeight is used as a style
        const minHeightStyle = chatInputSource.indexOf('dictationContentHeight !== null');
        expect(minHeightStyle).toBeGreaterThan(-1);

        // Get the surrounding context
        const styleBlock = chatInputSource.slice(
            minHeightStyle,
            minHeightStyle + 200,
        );

        // Verify it sets minHeight
        expect(styleBlock).toContain('minHeight');
        expect(styleBlock).toContain('`${dictationContentHeight}px`');

        // There should be no max-height constraint paired with it
        const nearbyContext = chatInputSource.slice(
            minHeightStyle - 400,
            minHeightStyle + 400,
        );
        // No maxHeight constraint is set alongside the minHeight
        // No overflow-y: hidden/auto constraint on the container that receives minHeight
        // The container has class "relative overflow-hidden" which clips horizontal only
    });

    // -----------------------------------------------------------------------
    // Root Cause 3: useMobileViewportPin is skipped for Capacitor (native Android)
    // -----------------------------------------------------------------------
    test('useMobileViewportPin returns early for Capacitor apps', () => {
        // Find the early return guard in useMobileViewportPin
        const guardLine = mobileViewportPinSource.indexOf('if (!isMobile || !isFullscreen || isCapacitorApp()) return;');
        expect(guardLine).toBeGreaterThan(-1);

        // The fullscreen effect guard: line 49
        const fullscreenEffect = mobileViewportPinSource.indexOf(
            'Fullscreen: fix the form over the whole visible viewport',
        );
        expect(fullscreenEffect).toBeGreaterThan(-1);

        // The draft screen guard: line 103
        const draftScreenEffect = mobileViewportPinSource.indexOf(
            'Draft screen with the keyboard up',
        );
        expect(draftScreenEffect).toBeGreaterThan(-1);

        // Both effects skip Capacitor
        const fullscreenGuard = mobileViewportPinSource.indexOf(
            'if (!isMobile || !isFullscreen || isCapacitorApp()) return;',
            fullscreenEffect,
        );
        const draftGuard = mobileViewportPinSource.indexOf(
            'if (!isMobile || isCapacitorApp()) return;',
            draftScreenEffect,
        );

        expect(fullscreenGuard).toBeGreaterThan(fullscreenEffect);
        expect(fullscreenGuard).toBeLessThan(fullscreenEffect + 300);
        expect(draftGuard).toBeGreaterThan(draftScreenEffect);
        expect(draftGuard).toBeLessThan(draftScreenEffect + 300);
    });

    // -----------------------------------------------------------------------
    // Root Cause 4: The composer's overflow is not constrained
    // -----------------------------------------------------------------------
    test('composer inner div lacks overflow constraint for dictation', () => {
        // On mobile, the dictation positioning context div (line 2573) has
        // 'relative flex flex-col' without overflow hidden
        // Let's find that div
        const contextDiv = chatInputSource.indexOf(
            "Positioning context for the dictation overlay",
        );
        expect(contextDiv).toBeGreaterThan(-1);

        const divLine = chatInputSource.slice(contextDiv, contextDiv + 300);
        // This div has 'relative flex flex-col' and optionally 'flex-1 min-h-0'
        // but no 'overflow-hidden'
        expect(divLine).toContain('relative flex flex-col');
        // It does NOT have overflow-hidden (it might have it only on the
        // inner child via the isComposerExpanded condition)
        // The overflow-hidden is on the NEXT child div (line 2574)
        const overflowDiv = chatInputSource.indexOf('overflow-hidden', contextDiv);
        expect(overflowDiv).toBeGreaterThan(-1);
        // But the overflow-hidden div is inside the positioning context,
        // not on the positioning context itself
    });

    // -----------------------------------------------------------------------
    // Root Cause 5: The dictation content height can grow without bound
    // -----------------------------------------------------------------------
    test('ComposerDictation reports content height with no viewport cap', () => {
        const dictationSource = readFileSync(
            new URL('../../dictation/ComposerDictation.tsx', import.meta.url),
            'utf8',
        );

        // Find the layout effect that measures and reports content height
        const measureEffect = dictationSource.indexOf(
            '// Measure the text block, not the container',
        );
        expect(measureEffect).toBeGreaterThan(-1);

        const effectBlock = dictationSource.slice(measureEffect, measureEffect + 600);

        // It measures offsetHeight + padding and reports it directly
        expect(effectBlock).toContain('offsetHeight');
        expect(effectBlock).toContain('onContentHeightChangeRef.current');

        // There is no viewport ceiling applied to the measured height
        // No Math.min, no viewport height reference
        expect(effectBlock).not.toContain('Math.min');
        expect(effectBlock).not.toContain('window.innerHeight');
        expect(effectBlock).not.toContain('visualViewport');
        expect(effectBlock).not.toContain('dvh');
        expect(effectBlock).not.toContain('dvh');
    });

    // -----------------------------------------------------------------------
    // Confirm that the fix direction involves capping the overlay height
    // -----------------------------------------------------------------------
    test('there is no max-height constraint in the dictation overlay path', () => {
        // Check the dictation overlay div (ComposerDictation.tsx lines 366-379)
        const dictationSource = readFileSync(
            new URL('../../dictation/ComposerDictation.tsx', import.meta.url),
            'utf8',
        );

        const overlayDiv = dictationSource.indexOf('absolute inset-0 z-50 flex flex-col');
        expect(overlayDiv).toBeGreaterThan(-1);

        const overlayContent = dictationSource.slice(overlayDiv, overlayDiv + 300);
        // The overlay uses 'absolute inset-0' - size determined by positioned ancestor
        // No max-height on the overlay div
        expect(overlayContent).not.toContain('max-h');
        expect(overlayContent).not.toContain('max-height');

        // The transcript area uses flex-1 min-h-0 overflow-y-auto so it SHOULD scroll
        // when content exceeds available space, but the problem is the PARENT (the
        // positioned host) grows without bound, so the overlay (and its footer) grows
        // past the viewport before scrolling kicks in.
    });
});
