/**
 * Reproduction test for issue #2506:
 * "[Bug] "the running turn was stopped" for every new chat"
 *
 * This test reproduces the scenario where a user creates a new chat session,
 * sends a message, and receives an assistant message with a MessageAbortedError
 * error that displays as "The running turn was stopped before OpenCode could
 * send the next message."
 *
 * The bug: Every new session's first message gets aborted, meaning the server
 * returns a MessageAbortedError on the assistant message. This test verifies
 * the client-side handling of this error and documents the conditions under
 * which it appears.
 *
 * Root cause analysis:
 * The error message appears in ChatMessage.tsx when an AssistantMessage has
 * an `error` field where the detail (trimmed, lowercased) is exactly 'aborted'.
 * For the SDK's MessageAbortedError type (name: "MessageAbortedError",
 * data.message: string), the detail is `data.message || error.name`.
 *
 * When the server sends data.message="aborted", the client shows
 * "The running turn was stopped before OpenCode could send the next message."
 *
 * The fact that this happens for EVERY new chat suggests the server is
 * aborting every turn immediately. This could be:
 * 1. A server-side issue where the session or turn is aborted right after
 *    the user sends a message
 * 2. A client-server interaction issue where the prompt request triggers
 *    an abort on the server side
 * 3. A configuration issue where the provider/model selection causes
 *    immediate failure
 */

import { describe, test, expect } from "bun:test";
import type { Message, Part } from "@opencode-ai/sdk/v2/client";

// Simulate the exact error detection logic from ChatMessage.tsx lines 682-721
function computeAssistantErrorMessage(message: { info: Message; parts: Part[] }): { text: string; variant: string } | undefined {
    const isUser = message.info.role === "user";
    if (isUser) return undefined;

    const errorInfo = (message.info as { error?: unknown } | undefined)?.error as
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
            variant: 'info',
        };
    }

    if (detail.trim().toLowerCase() === 'aborted') {
        return {
            text: 'The running turn was stopped before OpenCode could send the next message.',
            variant: 'info',
        };
    }
    return {
        text: `Opencode failed to send message with error:\n\`${detail}\``,
        variant: 'error',
    };
}

describe("Issue #2506 - MessageAbortedError handling", () => {
    /**
     * REPRODUCTION STEPS (as reported):
     * 1. Open OpenChamber Desktop (macOS)
     * 2. Create a new chat session
     * 3. Type a message and send it
     * 4. The assistant message shows: "The running turn was stopped before
     *    OpenCode could send the next message."
     * 5. This happens for every new session
     */

    test("MessageAbortedError with data.message='aborted' shows the 'running turn was stopped' text", () => {
        // This is the most likely server response for an aborted turn
        const assistantMessage = {
            info: {
                id: "assistant-1",
                role: "assistant" as const,
                sessionID: "session-1",
                parentID: "user-1",
                modelID: "model-1",
                providerID: "provider-1",
                error: {
                    name: "MessageAbortedError",
                    data: { message: "aborted" },
                },
            } as unknown as Message,
            parts: [] as Part[],
        };

        const result = computeAssistantErrorMessage(assistantMessage);
        expect(result).toEqual({
            text: 'The running turn was stopped before OpenCode could send the next message.',
            variant: 'info',
        });
    });

    test("MessageAbortedError with arbitrary data.message shows generic error, not 'running turn was stopped'", () => {
        const assistantMessage = {
            info: {
                id: "assistant-2",
                role: "assistant" as const,
                sessionID: "session-1",
                parentID: "user-1",
                modelID: "model-1",
                providerID: "provider-1",
                error: {
                    name: "MessageAbortedError",
                    data: { message: "Provider rate limit exceeded" },
                },
            } as unknown as Message,
            parts: [] as Part[],
        };

        const result = computeAssistantErrorMessage(assistantMessage);
        expect(result?.text).toContain("Opencode failed to send message with error");
        expect(result?.text).not.toContain("running turn was stopped");
    });

    test("User message never shows assistant error", () => {
        const userMessage = {
            info: {
                id: "user-1",
                role: "user" as const,
                sessionID: "session-1",
            } as unknown as Message,
            parts: [] as Part[],
        };

        const result = computeAssistantErrorMessage(userMessage);
        expect(result).toBe(undefined);
    });

    test("Assistant message WITHOUT error shows no error", () => {
        const assistantMessage = {
            info: {
                id: "assistant-3",
                role: "assistant" as const,
                sessionID: "session-1",
                parentID: "user-1",
                modelID: "model-1",
                providerID: "provider-1",
                // No error field
            } as unknown as Message,
            parts: [] as Part[],
        };

        const result = computeAssistantErrorMessage(assistantMessage);
        expect(result).toBe(undefined);
    });

    /**
     * The key insight: For the "running turn was stopped" error to appear,
     * the server must send a MessageAbortedError with data.message exactly
     * equal to "aborted" (case-insensitive after trim). This means the
     * server is actively aborting the assistant turn for every new session.
     *
     * Possible root causes:
     * 1. The server's abort endpoint is being called unexpectedly during
     *    session creation or message sending
     * 2. The `delivery: 'steer'` parameter causes the server to try to
     *    inject into a non-existent running turn, resulting in an abort
     * 3. A provider configuration issue causes the LLM call to fail
     *    immediately, which results in an aborted turn
     * 4. The session's `idle` status is not properly communicated, causing
     *    the server to think there's already a running turn
     *
     * Client-side code paths to investigate:
     * - packages/ui/src/lib/opencode/client.ts: sendMessage() - line ~745
     *   Calls this.client.session.promptAsync which sends the delivery param
     * - packages/ui/src/sync/session-actions.ts: optimisticSend() - line ~896
     *   Sets session_status to "busy" before sending, but only resets to
     *   "idle" on error (not on success - relies on SSE events)
     * - packages/ui/src/sync/session-ui-store.ts: sendMessage() - line ~1013
     *   For new sessions, creates session via materializeOpenDraftSession
     * - packages/ui/src/components/chat/ChatInput.tsx: handleSubmit() - line ~931
     *   Sets delivery='steer' when sessionPhase !== 'idle' (line 934)
     */
});
