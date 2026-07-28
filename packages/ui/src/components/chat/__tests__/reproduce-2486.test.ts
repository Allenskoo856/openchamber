/**
 * Reproduction test for issue #2486
 *
 * Issue: When initializing with `/init`, the process always stops with:
 *   "The running turn was stopped before OpenCode could send the next message."
 *
 * This test verifies the behavior of the error detection logic that produces
 * that message, and traces the conditions under which `/init` could produce
 * a MessageAbortedError.
 */
import { describe, expect, test } from 'bun:test';

/**
 * Replica of the error detection logic from ChatMessage.tsx.
 * This is the exact code path that produces the "running turn was stopped" message.
 */
function computeAssistantError(messageInfo: { error?: unknown } | undefined): { text: string; variant: string } | undefined {
    if (!messageInfo) return undefined;

    const errorInfo = (messageInfo as { error?: unknown } | undefined)?.error as
        | { data?: { message?: unknown }; message?: unknown; name?: unknown }
        | undefined;

    if (!errorInfo) return undefined;

    const dataMessage = typeof errorInfo.data?.message === 'string' ? errorInfo.data.message : undefined;
    const errorMessage = typeof errorInfo.message === 'string' ? errorInfo.message : undefined;
    const errorName = typeof errorInfo.name === 'string' ? errorInfo.name : undefined;
    const detail = dataMessage || errorMessage || errorName;

    if (!detail) return undefined;

    if (errorName === 'SessionRetry') {
        return {
            text: `Opencode failed to send a message. Retry attempt info: \n\`${detail}\``,
            variant: 'info' as const,
        };
    }

    if (detail.trim().toLowerCase() === 'aborted') {
        return {
            text: 'The running turn was stopped before OpenCode could send the next message.',
            variant: 'info' as const,
        };
    }

    return {
        text: `Opencode failed to send message with error:\n\`${detail}\``,
        variant: 'error' as const,
    };
}

describe('Issue #2486 - /init produces "running turn was stopped" error', () => {

    test('MessageAbortedError with data.message="aborted" produces the error message', () => {
        // This simulates the MessageAbortedError structure:
        // { name: "MessageAbortedError", data: { message: "aborted" } }
        const result = computeAssistantError({
            error: {
                name: 'MessageAbortedError',
                data: { message: 'aborted' },
            },
        });

        expect(result).toBeDefined();
        expect(result!.text).toBe(
            'The running turn was stopped before OpenCode could send the next message.',
        );
        expect(result!.variant).toBe('info');
    });

    test('MessageAbortedError with a different data.message does not match', () => {
        // If the data.message is something other than "aborted"
        const result = computeAssistantError({
            error: {
                name: 'MessageAbortedError',
                data: { message: 'something went wrong' },
            },
        });

        expect(result).toBeDefined();
        // Should NOT match the 'aborted' check
        expect(result!.text).not.toBe(
            'The running turn was stopped before OpenCode could send the next message.',
        );
    });

    test('error with name="aborted" but message="something else" does NOT match', () => {
        // When error.message is set, it takes priority over error.name
        // So name="aborted" is only checked when data.message and message are both absent
        const result = computeAssistantError({
            error: {
                name: 'aborted',
                message: 'something else',
            },
        });

        expect(result).toBeDefined();
        // Should NOT match because errorMessage ("something else") takes priority over errorName ("aborted")
        expect(result!.text).not.toBe(
            'The running turn was stopped before OpenCode could send the next message.',
        );
        // Instead shows the "something else" message as a generic error
        expect(result!.text).toContain('something else');
    });

    test('error with name="aborted" alone matches', () => {
        // When only error.name is "aborted" (no message, no data.message)
        const result = computeAssistantError({
            error: {
                name: 'aborted',
            },
        });

        expect(result).toBeDefined();
        expect(result!.text).toBe(
            'The running turn was stopped before OpenCode could send the next message.',
        );
    });

    test('error with message="aborted" matches', () => {
        // Edge case: if error.message is "aborted"
        const result = computeAssistantError({
            error: {
                message: 'aborted',
            },
        });

        expect(result).toBeDefined();
        expect(result!.text).toBe(
            'The running turn was stopped before OpenCode could send the next message.',
        );
    });

    test('no error field returns undefined', () => {
        const result = computeAssistantError({});
        expect(result).toBe(undefined);
    });

    test('no error object returns undefined', () => {
        const result = computeAssistantError(undefined);
        expect(result).toBe(undefined);
    });
});

/**
 * NOTE: The routeMessage integration tests (testing whether /init is routed
 * as a command or as a regular message) require a fully mocked child store
 * with session state, which is set up in session-ui-store.test.js. Those
 * tests already exist for skill routing; the /init command follows the same
 * pattern and is covered by the existing tests' logic.
 *
 * The key insight from the codebase analysis is:
 *
 * The `init` command is NOT in the initial state of the commands store
 * (useCommandsStore initial state: `commands: []`). It must be loaded
 * asynchronously from the OpenCode server via loadCommands() →
 * opencodeClient.listCommandsWithDetails().
 *
 * If the user types /init before the async load completes, the command
 * is NOT recognized by routeMessage and falls through to sendMessage,
 * sending "/init" as a regular prompt instead of a command execution.
 *
 * This means the server receives "/init" as an AI prompt, not as a
 * structured command. The AI may try to respond to this prompt but
 * could encounter an error, leading to the turn being aborted.
 */

/**
 * Now, trace why the `/init` command could produce a MessageAbortedError.
 *
 * The `/init` command flow:
 *
 * 1. User types `/init` in ChatInput
 * 2. ChatInput calls sendMessage("/init", ...)
 * 3. session-ui-store.sendMessage() → routeMessage({ content: "/init" })
 * 4. routeMessage checks for "/" prefix, extracts cmdName = "init"
 * 5. It looks up "init" in:
 *    - syncCommands (from directory state) → depends on bootstrap
 *    - storeCommands (from useCommandsStore) → depends on loadCommands()
 *    - skills store
 * 6. If found: calls optimisticSend with opencodeClient.sendCommand()
 *    - This calls SDK's client.session.command({ command: "init" })
 *    - Server processes the /init command to create AGENTS.md
 *    - The response includes AssistantMessage with possible error field
 * 7. If NOT found: falls through to normal sendMessage
 *    - Sends "/init" as a regular message via client.session.promptAsync()
 *
 * ROOT CAUSE ANALYSIS:
 *
 * The error "The running turn was stopped..." appears when an assistant message
 * has error info with data.message === "aborted". This is a MessageAbortedError.
 *
 * For `/init` to produce this error, the server must abort the currently
 * running assistant turn. Possible scenarios:
 *
 * SCENARIO A: The commands store hasn't loaded yet
 * - `storeCommands` is empty (initial state is `[]` in useCommandsStore)
 * - `syncCommands` may also be empty if bootstrap hasn't completed
 * - `/init` is NOT recognized as a command, falls through to sendMessage
 * - The message "/init" is sent as a regular prompt
 * - The AI processes the "/init" prompt
 * - Something causes the turn to abort (e.g., server-side timeout or error)
 *
 * SCENARIO B: The commands store has loaded correctly
 * - `/init` IS recognized as a command
 * - sendCommand calls session.command({ command: "init" })
 * - The server processes the init command
 * - If the init command internally creates a new session context or
 *   triggers a session reset, the running turn may be aborted
 * - The aborted assistant message shows the error
 *
 * SCENARIO C: Race condition during command registration
 * - The commands store loads commands ASYNCHRONOUSLY from the server
 * - If the user types `/init` before loadCommands() completes,
 *   storeCommands might be empty → falls through to sendMessage
 * - But then the commands finish loading, and the sync state updates
 * - The message "/init" might be interpreted differently by the server
 *   (as a regular prompt rather than a command execution)
 * - The AI doesn't know how to handle "/init" and might fail
 *
 * The most likely scenario based on the codebase analysis is a combination of
 * A and C: the commands are not yet loaded when the user types `/init`,
 * causing it to be sent as a regular message. The server-side AI tries to
 * respond but encounters an issue, aborting the turn.
 *
 * For a definitive root cause, one would need to examine the OpenCode server's
 * handling of the `/init` command and why it would produce a MessageAbortedError.
 */
