/**
 * blindSpots.js
 *
 * Detects failure categories that automated evaluators consistently miss.
 * A "blind spot" is when humans flag an issue (label = incorrect/fail/poor)
 * but the evaluator gave a high score (>= threshold) for that dimension.
 *
 * This closes the meta-evaluation flywheel by surfacing where the
 * evaluator needs to improve.
 */

const db = require('../db');
const { mapLabelToNumeric, ANNOTATION_TO_EVAL_KEY } = require('./calibration');

module.exports.detectBlindSpots = async (days, evalScoreThreshold = 0.7) => {
    // Fetch all annotations joined with evaluations
    let query = `
        SELECT 
            a.conversation_id, a.annotation_type, a.label, a.confidence,
            e.scores
        FROM annotations a
        INNER JOIN evaluations e ON a.conversation_id = e.conversation_id
    `;
    const params = [];
    if (days) {
        query += ' WHERE a.created_at >= DATE_SUB(NOW(), INTERVAL ? DAY)';
        params.push(String(days));
    }

    const rows = await db.execute(query, params);

    if (!rows.length) {
        return { blind_spots: [], total_annotations_analyzed: 0 };
    }

    // Track blind spots per category
    const categoryStats = {};
    const totalByCategory = {};

    for (const row of rows) {
        const annoType = row.annotation_type;
        const evalKey = ANNOTATION_TO_EVAL_KEY[annoType];
        if (!evalKey) continue;

        const humanScore = mapLabelToNumeric(row.label);
        if (humanScore === null) continue;

        let scores = {};
        try {
            scores = typeof row.scores === 'string' ? JSON.parse(row.scores) : row.scores;
        } catch (e) { continue; }

        const evalDimScore = scores[evalKey];
        if (evalDimScore === null || evalDimScore === undefined) continue;

        // Count total annotations per category
        if (!totalByCategory[annoType]) totalByCategory[annoType] = 0;
        totalByCategory[annoType]++;

        // Blind spot: human says BAD (< 0.5) but evaluator says GOOD (>= threshold)
        const humanSaysBad = humanScore < 0.5;
        const evalSaysGood = evalDimScore >= evalScoreThreshold;

        if (humanSaysBad && evalSaysGood) {
            if (!categoryStats[annoType]) {
                categoryStats[annoType] = {
                    miss_count: 0,
                    eval_scores_when_missed: [],
                    human_scores_when_missed: [],
                    sample_conversation_ids: []
                };
            }

            const stats = categoryStats[annoType];
            stats.miss_count++;
            stats.eval_scores_when_missed.push(evalDimScore);
            stats.human_scores_when_missed.push(humanScore);

            if (stats.sample_conversation_ids.length < 5 &&
                !stats.sample_conversation_ids.includes(row.conversation_id)) {
                stats.sample_conversation_ids.push(row.conversation_id);
            }
        }
    }

    // Build results
    const blind_spots = [];
    for (const [category, stats] of Object.entries(categoryStats)) {
        const total = totalByCategory[category] || 1;
        const avgEvalWhenMissed = stats.eval_scores_when_missed.reduce((a, b) => a + b, 0) / stats.eval_scores_when_missed.length;
        const avgHumanWhenMissed = stats.human_scores_when_missed.reduce((a, b) => a + b, 0) / stats.human_scores_when_missed.length;

        blind_spots.push({
            category,
            eval_dimension: ANNOTATION_TO_EVAL_KEY[category],
            miss_count: stats.miss_count,
            miss_rate: +(stats.miss_count / total).toFixed(4),
            total_annotations: total,
            sample_conversation_ids: stats.sample_conversation_ids,
            avg_eval_score_when_missed: +avgEvalWhenMissed.toFixed(4),
            avg_human_score_when_missed: +avgHumanWhenMissed.toFixed(4),
            severity: stats.miss_count / total > 0.3 ? 'high' : stats.miss_count / total > 0.1 ? 'medium' : 'low'
        });
    }

    // Sort by miss_rate descending
    blind_spots.sort((a, b) => b.miss_rate - a.miss_rate);

    return {
        blind_spots,
        total_annotations_analyzed: Object.values(totalByCategory).reduce((a, b) => a + b, 0),
        eval_score_threshold: evalScoreThreshold
    };
};
