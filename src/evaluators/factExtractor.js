/**
 * factExtractor.js
 *
 * Pure data extraction — no scoring, no thresholds, no judgments.
 * Pulls objective facts from a conversation that GPT-4o needs to evaluate it.
 *
 * This replaces the rule-based logic in heuristic.js and toolCall.js.
 * The AI decides what these facts mean; this file just surfaces them.
 */

const CONSTRAINT_PATTERNS = [
    /\bonly\s+(.+?)(?:[.,!?]|$)/gi,
    /\bi\s+prefer\s+(.+?)(?:[.,!?]|$)/gi,
    /\bkeep\s+in\s+mind\s+(.+?)(?:[.,!?]|$)/gi,
    /\bremember\s+(?:that\s+)?(.+?)(?:[.,!?]|$)/gi,
    /\bnever\s+(.+?)(?:[.,!?]|$)/gi,
    /\balways\s+(.+?)(?:[.,!?]|$)/gi,
    /\bmust\s+be\s+(.+?)(?:[.,!?]|$)/gi,
];

function extractConstraints(turns) {
    const constraints = [];
    const earlyTurns = turns.slice(0, Math.ceil(turns.length / 2));
    for (const turn of earlyTurns) {
        if (turn.role !== 'user') continue;
        const text = turn.content || '';
        for (const pattern of CONSTRAINT_PATTERNS) {
            pattern.lastIndex = 0;
            let match;
            while ((match = pattern.exec(text)) !== null) {
                const captured = match[1].trim();
                if (captured.length > 2) constraints.push(captured);
            }
        }
    }
    return [...new Set(constraints)];
}

module.exports.extract = (conversation) => {
    const turns    = conversation.turns    || [];
    const metadata = conversation.metadata || {};

    // ── Turn structure ────────────────────────────────────────────────────────
    let turnStructureValid = true;
    let expectedRole = 'user';
    const emptyResponses = [];

    for (const turn of turns) {
        if (turn.role !== expectedRole) turnStructureValid = false;
        expectedRole = turn.role === 'user' ? 'assistant' : 'user';

        if (turn.role === 'assistant' && !turn.content?.trim()) {
            emptyResponses.push(turn.turn_id);
        }
    }

    // ── Tool call facts ───────────────────────────────────────────────────────
    const toolCalls = [];
    let priorUserText = '';

    for (const turn of turns) {
        if (turn.role === 'user') {
            priorUserText += ' ' + (turn.content || '').toLowerCase();
        }

        if (turn.role === 'assistant' && turn.tool_calls?.length) {
            for (const tc of turn.tool_calls) {
                // Check each string param against prior user text (word-level)
                const possiblyUngroundedParams = [];
                if (tc.parameters) {
                    for (const [k, v] of Object.entries(tc.parameters)) {
                        if (typeof v !== 'string' || v.length <= 3) continue;
                        if (/^\d{4}-\d{2}-\d{2}/.test(v)) continue; // skip ISO dates
                        const words = v.toLowerCase().split(/[\s,/\-]+/).filter(w => w.length > 3);
                        const grounded = words.length === 0 || words.some(w => priorUserText.includes(w));
                        if (!grounded) possiblyUngroundedParams.push({ param: k, value: v });
                    }
                }

                toolCalls.push({
                    tool_name:                 tc.tool_name,
                    parameters:                tc.parameters || {},
                    possibly_ungrounded_params: possiblyUngroundedParams,
                    execution_success:         tc.result?.status === 'success',
                    latency_ms:                tc.latency_ms || 0,
                    result_summary:            tc.result ? JSON.stringify(tc.result).slice(0, 100) : null
                });
            }
        }
    }

    // ── User-stated constraints ───────────────────────────────────────────────
    const constraints = extractConstraints(turns);

    return {
        // Timing
        total_latency_ms:   metadata.total_latency_ms  || 0,
        mission_completed:  metadata.mission_completed  || false,

        // Structure
        turn_count:           turns.length,
        turn_structure_valid: turnStructureValid,
        empty_response_turns: emptyResponses,

        // Tools
        tool_calls: toolCalls,

        // User intent
        user_constraints: constraints,

        // Flags for the AI prompt
        has_tool_calls:    toolCalls.length > 0,
        has_enough_turns:  turns.length >= 3,
    };
};
