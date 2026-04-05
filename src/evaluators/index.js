const { v4: uuidv4 } = require('uuid');
const db           = require('../db');
const factExtractor = require('./factExtractor');
const llmEvaluator  = require('./llmEvaluator');
const calibration   = require('../meta/calibration');

async function fetchMatchingSuggestions(issues) {
    if (!issues.length) return [];
    const issueTypes   = [...new Set(issues.map(i => i.type))];
    const placeholders = issueTypes.map(() => '?').join(',');
    return db.execute(
        `SELECT id, type, target, suggestion, rationale, confidence FROM suggestions
         WHERE target IN (${placeholders}) AND status = 'pending'
         ORDER BY confidence DESC LIMIT 5`,
        issueTypes
    );
}

module.exports.evaluateConversation = async (conversation) => {

    // ── Step 1: Extract objective facts (no scoring) ──────────────────────────
    const facts = factExtractor.extract(conversation);

    // ── Step 2: Single GPT-4o call evaluates all four dimensions ─────────────
    const { llmJudge, coherence, heuristic, toolCall } = await llmEvaluator.evaluate(conversation, facts);

    // ── Step 3: Compute overall score ─────────────────────────────────────────
    // Weights: LLM 30% | ToolCall 30% | Coherence 20% | Heuristic 20%
    // Rebalance when coherence or toolCall is N/A
    const hasCoherence = !coherence.isNA;
    const hasToolCall  = !toolCall.isNA;

    let totalWeight = 0;
    let score = 0;

    score       += llmJudge.score  * 0.30; totalWeight += 0.30;
    score       += heuristic.score * 0.20; totalWeight += 0.20;

    if (hasCoherence) { score += coherence.score * 0.20; totalWeight += 0.20; }
    if (hasToolCall)  { score += toolCall.score  * 0.30; totalWeight += 0.30; }

    // Normalise if some dimensions were N/A
    if (totalWeight < 1.0) score = score / totalWeight;

    // ── Step 4: Apply drift correction from meta-evaluation ────────────────
    let correctionFactor = 1.0;
    try {
        correctionFactor = await calibration.getLatestCorrection('v4');
    } catch (_) { /* no corrections yet */ }

    if (correctionFactor !== 1.0) {
        score = Math.max(0, Math.min(1, score * correctionFactor));
    }

    // ── Step 5: Latency penalty (proportional, not a hard cap) ────────────────
    // A hard cap at 0.70 was inflating scores of bad conversations with high latency.
    // Instead apply a proportional 15% penalty so bad conversations still score low.
    if (facts.total_latency_ms > 3000) score = score * 0.85;

    // ── Step 6: Collect all issues ────────────────────────────────────────────
    const allIssues = [
        ...(heuristic.issues || []),
        ...(toolCall.issues  || []),
        ...(llmJudge.issues  || []),
        ...(coherence.issues || [])
    ];

    // ── Step 7: Confidence-based routing ──────────────────────────────────────
    const review_routing = { needs_human_review: false, reasons: [] };

    // Rule 1: Overall score in ambiguous zone (0.4–0.6)
    if (score >= 0.4 && score <= 0.6) {
        review_routing.needs_human_review = true;
        review_routing.reasons.push('ambiguous_overall_score');
    }

    // Rule 2: Dimension disagreement (>0.4 spread between active dimensions)
    const activeDimScores = [llmJudge.score, heuristic.score];
    if (hasCoherence) activeDimScores.push(coherence.score);
    if (hasToolCall)  activeDimScores.push(toolCall.score);
    const dimSpread = Math.max(...activeDimScores) - Math.min(...activeDimScores);
    if (dimSpread > 0.4) {
        review_routing.needs_human_review = true;
        review_routing.reasons.push('dimension_disagreement');
    }

    // Rule 3: Critical issues detected
    if (allIssues.some(i => i.severity === 'critical')) {
        review_routing.needs_human_review = true;
        review_routing.reasons.push('critical_issue_detected');
    }

    // ── Step 8: Build scores object ───────────────────────────────────────────
    const scores = {
        overall:      +score.toFixed(4),
        llmJudge:     +llmJudge.score.toFixed(4),
        heuristic:    +heuristic.score.toFixed(4),
        coherence:    hasCoherence ? +coherence.score.toFixed(4) : null,
        coherence_na: !hasCoherence,
        toolCall:     hasToolCall  ? +toolCall.score.toFixed(4)  : null,
        toolCall_na:  !hasToolCall
    };

    const toolEvaluation = {
        facts: {
            tool_count: facts.tool_calls.length
        },
        ai: hasToolCall ? toolCall.details : null
    };

    // ── Step 9: Fetch matching suggestions ────────────────────────────────────
    const improvement_suggestions = await fetchMatchingSuggestions(allIssues);

    // ── Step 10: Persist ──────────────────────────────────────────────────────
    const id = uuidv4();
    await db.execute(
        `INSERT INTO evaluations (id, conversation_id, scores, tool_evaluation, issues_detected, improvement_suggestions, evaluator_version)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [
            id,
            conversation.id || conversation.conversation_id,
            JSON.stringify({ ...scores, review_routing }),
            JSON.stringify(toolEvaluation),
            JSON.stringify(allIssues),
            JSON.stringify(improvement_suggestions),
            'v4'
        ]
    );

    return {
        id,
        conversation_id:          conversation.id || conversation.conversation_id,
        scores,
        review_routing,
        tool_evaluation:          toolEvaluation,
        issues_detected:          allIssues,
        improvement_suggestions,
        evaluator_version:        'v4'
    };
};
