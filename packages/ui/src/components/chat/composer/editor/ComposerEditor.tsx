/**
 * The composer's text editor.
 *
 * This replaces the transparent-textarea-over-mirror-div arrangement the
 * composer used before. That arrangement could only paint styles which do not
 * change glyph advance width — colour, background, underline — because any
 * metric change made the mirror drift out from under the caret. Bold, italic
 * and any width-affecting affordance were therefore impossible, and the
 * overlay had to be disabled outright on mobile, where wrapped text drifted
 * anyway.
 *
 * CodeMirror owns the text and the caret together, so there is no second layer
 * to keep aligned. The document remains a plain string — `getValue()` is
 * exactly what gets sent — so nothing downstream has to serialize a rich
 * document model back into a prompt.
 *
 * The component is a controlled primitive: it renders `value`, reports edits,
 * and exposes an imperative handle for the caret-level operations the composer
 * performs (insert a mention, restore a draft, replace a token). Every policy
 * decision — what a key means, which picker opens, when to send — stays with
 * the caller.
 */

import React from 'react';
import { history, historyKeymap, standardKeymap } from '@codemirror/commands';
import { Compartment, EditorState, Prec, type Extension } from '@codemirror/state';
import {
    EditorView,
    drawSelection,
    keymap,
    placeholder as placeholderExtension,
    type KeyBinding,
} from '@codemirror/view';

import { cn } from '@/lib/utils';
import type { ComposerLanguageContext } from '../language/tokenize';
import { composerLanguage, setLanguageContext } from './composerLanguage';

export interface ComposerSelection {
    start: number;
    end: number;
}

export interface ComposerChange {
    value: string;
    selection: ComposerSelection;
    /** True when the edit came from a paste rather than typing. */
    fromPaste: boolean;
    /** The text this edit inserted, empty for deletions. */
    insertedText: string;
}

export interface ComposerEditorHandle {
    focus(options?: { preventScroll?: boolean }): void;
    blur(): void;
    isFocused(): boolean;
    getValue(): string;
    getSelection(): ComposerSelection;
    setSelection(start: number, end?: number): void;
    selectAll(): void;
    /** Replace the current selection, leaving the caret after the insertion. */
    insertText(text: string): void;
    /** Replace an explicit range; the caret lands at `caret` or after the text. */
    replaceRange(from: number, to: number, text: string, caret?: number): void;
    /** Viewport coordinates of the caret, for positioning popups. */
    caretCoords(position?: number): { top: number; bottom: number; left: number } | null;
    /** The scrollable element, for measuring and scroll compensation. */
    getScrollDOM(): HTMLElement | null;
}

export interface ComposerEditorProps {
    value: string;
    onChange: (change: ComposerChange) => void;
    /** Caret or selection moved without the document changing. */
    onSelectionChange?: (selection: ComposerSelection) => void;
    /**
     * Key press before CodeMirror handles it. Return true to consume the
     * event — this is where the composer routes autocomplete navigation,
     * message history and send.
     */
    onKeyDown?: (event: KeyboardEvent) => boolean;
    onFocus?: () => void;
    onBlur?: () => void;
    onPaste?: (event: ClipboardEvent) => void;
    languageContext: ComposerLanguageContext;
    placeholder?: string;
    editable?: boolean;
    spellCheck?: boolean;
    /** Mobile keyboards; ignored on desktop. */
    autoCorrect?: boolean;
    autoCapitalize?: 'none' | 'sentences';
    /** Fill the available height instead of growing with the content. */
    fillContainer?: boolean;
    /** Lines of text shown before the editor starts scrolling. */
    maxLines?: number;
    className?: string;
    contentClassName?: string;
    'aria-label'?: string;
    'data-testid'?: string;
}

/** Layout and typography. Colour comes from the shared highlight classes. */
const baseTheme = EditorView.theme({
    '&': {
        backgroundColor: 'transparent',
        color: 'var(--surface-foreground)',
    },
    '&.cm-focused': { outline: 'none' },
    '.cm-content': {
        padding: '0',
        caretColor: 'var(--surface-foreground)',
        fontFamily: 'inherit',
        fontSize: 'inherit',
        lineHeight: 'inherit',
    },
    '.cm-line': { padding: '0' },
    '.cm-scroller': {
        fontFamily: 'inherit',
        fontSize: 'inherit',
        lineHeight: 'inherit',
        overflowX: 'hidden',
    },
    '.cm-placeholder': { color: 'var(--surface-mutedForeground)' },
    '&.cm-editor .cm-selectionBackground, & .cm-selectionBackground': {
        backgroundColor: 'var(--interactive-selection)',
    },
});

/**
 * The text inserted by a transaction, used to tell a typed `@` from a pasted
 * one. CodeMirror reports the change set directly, so this needs none of the
 * prefix/suffix diffing a textarea's `onChange` required.
 */
function insertedTextOf(transaction: { changes: { iterChanges: (fn: (fromA: number, toA: number, fromB: number, toB: number, inserted: { toString(): string }) => void) => void } }): string {
    let inserted = '';
    transaction.changes.iterChanges((_fromA, _toA, _fromB, _toB, text) => {
        inserted += text.toString();
    });
    return inserted;
}

export const ComposerEditor = React.forwardRef<ComposerEditorHandle, ComposerEditorProps>(
    function ComposerEditor(props, ref) {
        const {
            value,
            languageContext,
            placeholder,
            editable = true,
            spellCheck = false,
            autoCorrect = false,
            autoCapitalize = 'none',
            fillContainer = false,
            maxLines = 8,
            className,
            contentClassName,
        } = props;

        const hostRef = React.useRef<HTMLDivElement | null>(null);
        const viewRef = React.useRef<EditorView | null>(null);
        // `editable` toggles through a compartment rather than rebuilding the
        // view, so briefly having no session does not drop focus or undo
        // history.
        const editableCompartment = React.useRef(new Compartment()).current;
        const placeholderCompartment = React.useRef(new Compartment()).current;

        // Callbacks reach the CodeMirror extensions through refs: the view is
        // created once and must not be torn down when a handler identity
        // changes, which would drop focus mid-typing.
        const propsRef = React.useRef(props);
        propsRef.current = props;

        React.useEffect(() => {
            const host = hostRef.current;
            if (!host) return;

            const interceptKeys: KeyBinding[] = [{
                any: (_view, event) => propsRef.current.onKeyDown?.(event) ?? false,
            }];

            const view = new EditorView({
                state: EditorState.create({
                    doc: propsRef.current.value,
                    extensions: [
                        history(),
                        drawSelection(),
                        EditorView.lineWrapping,
                        // Highest precedence: the composer's own keys must win
                        // over CodeMirror's defaults (Enter sends, ArrowUp
                        // walks history, Escape closes a picker).
                        Prec.highest(keymap.of(interceptKeys)),
                        keymap.of([...standardKeymap, ...historyKeymap]),
                        composerLanguage(propsRef.current.languageContext),
                        editableCompartment.of(
                            EditorView.editable.of(propsRef.current.editable ?? true),
                        ),
                        placeholderCompartment.of(
                            placeholderExtension(propsRef.current.placeholder ?? ''),
                        ),
                        baseTheme,
                        EditorView.updateListener.of((update) => {
                            const handlers = propsRef.current;
                            const selection = readSelection(update.state);

                            if (update.docChanged) {
                                const fromPaste = update.transactions.some(
                                    (transaction) => transaction.isUserEvent('input.paste'),
                                );
                                let insertedText = '';
                                for (const transaction of update.transactions) {
                                    insertedText += insertedTextOf(transaction);
                                }
                                handlers.onChange({
                                    value: update.state.doc.toString(),
                                    selection,
                                    fromPaste,
                                    insertedText,
                                });
                                return;
                            }

                            if (update.selectionSet) {
                                handlers.onSelectionChange?.(selection);
                            }
                        }),
                        EditorView.domEventHandlers({
                            focus: () => { propsRef.current.onFocus?.(); return false; },
                            blur: () => { propsRef.current.onBlur?.(); return false; },
                            paste: (event) => { propsRef.current.onPaste?.(event); return false; },
                        }),
                        EditorView.contentAttributes.of({
                            spellcheck: String(propsRef.current.spellCheck ?? false),
                            autocorrect: propsRef.current.autoCorrect ? 'on' : 'off',
                            autocapitalize: propsRef.current.autoCapitalize ?? 'none',
                            ...(propsRef.current['aria-label']
                                ? { 'aria-label': propsRef.current['aria-label'] }
                                : {}),
                        }),
                    ] satisfies Extension[],
                }),
                parent: host,
            });

            viewRef.current = view;
            return () => {
                view.destroy();
                viewRef.current = null;
            };
            // Created once: every changing input is applied through a
            // dispatch below rather than by rebuilding the view.
            // eslint-disable-next-line react-hooks/exhaustive-deps
        }, []);

        // Controlled value: only write back when the prop and the document
        // genuinely differ, otherwise every keystroke would round-trip and
        // reset the caret.
        React.useEffect(() => {
            const view = viewRef.current;
            if (!view) return;
            const current = view.state.doc.toString();
            if (current === value) return;
            view.dispatch({
                changes: { from: 0, to: current.length, insert: value },
                // Keep the caret in a valid place after an external rewrite
                // (draft restore, history navigation, dictation insert).
                selection: { anchor: Math.min(view.state.selection.main.anchor, value.length) },
            });
        }, [value]);

        React.useEffect(() => {
            viewRef.current?.dispatch({ effects: setLanguageContext.of(languageContext) });
        }, [languageContext]);

        React.useEffect(() => {
            viewRef.current?.dispatch({
                effects: editableCompartment.reconfigure(EditorView.editable.of(editable)),
            });
        }, [editable, editableCompartment]);

        React.useEffect(() => {
            viewRef.current?.dispatch({
                effects: placeholderCompartment.reconfigure(placeholderExtension(placeholder ?? '')),
            });
        }, [placeholder, placeholderCompartment]);

        // Grow with the content up to `maxLines`, then scroll. The limit is
        // measured from the rendered line height rather than assumed, so it
        // tracks the composer's responsive typography.
        React.useEffect(() => {
            const view = viewRef.current;
            const host = hostRef.current;
            if (!view || !host || fillContainer) return;

            const applyLimit = () => {
                const lineHeight = parseFloat(
                    getComputedStyle(view.contentDOM).lineHeight || '',
                );
                if (!Number.isFinite(lineHeight) || lineHeight <= 0) return;
                view.scrollDOM.style.maxHeight = `${lineHeight * maxLines}px`;
            };

            applyLimit();
            if (typeof ResizeObserver === 'undefined') return;
            const observer = new ResizeObserver(applyLimit);
            observer.observe(host);
            return () => observer.disconnect();
        }, [fillContainer, maxLines]);

        React.useEffect(() => {
            const view = viewRef.current;
            if (!view) return;
            const content = view.contentDOM;
            content.setAttribute('spellcheck', String(spellCheck));
            content.setAttribute('autocorrect', autoCorrect ? 'on' : 'off');
            content.setAttribute('autocapitalize', autoCapitalize);
        }, [autoCapitalize, autoCorrect, spellCheck]);

        React.useImperativeHandle(ref, (): ComposerEditorHandle => ({
            focus(options) {
                const view = viewRef.current;
                if (!view) return;
                // preventScroll matters on mobile, where the browser's own
                // scroll-into-view fights the keyboard choreography.
                view.contentDOM.focus({ preventScroll: options?.preventScroll });
            },
            blur() {
                viewRef.current?.contentDOM.blur();
            },
            isFocused() {
                return viewRef.current?.hasFocus ?? false;
            },
            getValue() {
                return viewRef.current?.state.doc.toString() ?? '';
            },
            getSelection() {
                const view = viewRef.current;
                return view ? readSelection(view.state) : { start: 0, end: 0 };
            },
            setSelection(start, end = start) {
                const view = viewRef.current;
                if (!view) return;
                const max = view.state.doc.length;
                view.dispatch({
                    selection: {
                        anchor: Math.min(Math.max(start, 0), max),
                        head: Math.min(Math.max(end, 0), max),
                    },
                });
            },
            selectAll() {
                const view = viewRef.current;
                if (!view) return;
                view.dispatch({ selection: { anchor: 0, head: view.state.doc.length } });
            },
            insertText(text) {
                const view = viewRef.current;
                if (!view || !text) return;
                const { from, to } = view.state.selection.main;
                view.dispatch({
                    changes: { from, to, insert: text },
                    selection: { anchor: from + text.length },
                    userEvent: 'input.type',
                });
            },
            replaceRange(from, to, text, caret) {
                const view = viewRef.current;
                if (!view) return;
                view.dispatch({
                    changes: { from, to, insert: text },
                    selection: { anchor: caret ?? from + text.length },
                    userEvent: 'input.type',
                });
            },
            caretCoords(position) {
                const view = viewRef.current;
                if (!view) return null;
                const pos = position ?? view.state.selection.main.head;
                const coords = view.coordsAtPos(pos);
                return coords
                    ? { top: coords.top, bottom: coords.bottom, left: coords.left }
                    : null;
            },
            getScrollDOM() {
                return viewRef.current?.scrollDOM ?? null;
            },
        }), []);

        return (
            <div
                ref={hostRef}
                data-testid={props['data-testid']}
                className={cn(
                    'composer-editor w-full',
                    fillContainer && 'flex min-h-0 flex-1 flex-col',
                    className,
                    contentClassName,
                )}
            />
        );
    },
);

function readSelection(state: EditorState): ComposerSelection {
    const range = state.selection.main;
    return { start: range.from, end: range.to };
}
