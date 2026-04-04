const db = require('../db');

// ─── Shared: map text labels to 0-1 numeric scores ──────────────────────────
function mapLabelToNumeric(label) {
    if (!label) return null;
    const l = label.toLowerCase();
    if (l === 'correct' || l === 'pass' || l === 'good' || l === 'yes' || l === 'true') return 1;
    if (l === 'partially_correct' || l === 'fair') return 0.5;
    if (l === 'incorrect' || l === 'fail' || l === 'poor' || l === 'no' || l === 'false') return 0;

    const num = parseFloat(label);
    if (!isNaN(num)) {
        if (num > 1) return num / 5; // assumes a 5 point scale
        return num;
    }
    return null;
}

// ─── Map annotation types to evaluator score keys ────────────────────────────
const ANNOTATION_TO_EVAL_KEY = {
    tool_accuracy: 'toolCall',
    helpfulness:   'llmJudge',
    coherence:     'coherence'
};

// ─── Fix 1: Confidence-weighted human score comparison ───────────────────────
module.exports.compareEvalToHuman = async (conversation_id) => {
    const [evalRows, annoRows] = await Promise.all([
        db.execute('SELECT * FROM evaluations WHERE conversation_id = ? ORDER BY created_at DESC LIMIT 1', [conversation_id]),
        db.execute('SELECT * FROM annotations WHERE conversation_id = ?', [conversation_id])
    ]);

    if (!evalRows.length || !annoRows.length) return null;

    const evaluation = evalRows[0];
    let scores = {};
    try {
        scores = typeof evaluation.scores === 'string' ? JSON.parse(evaluation.scores) : evaluation.scores;
    } catch (e) {
        scores = {};
    }
    const evalScore = scores.overall || 0;

    // Confidence-weighted averaging: Σ(score × confidence) / Σ(confidence)
    let weightedSum = 0;
    let confidenceSum = 0;

    for (const an of annoRows) {
        const num = mapLabelToNumeric(an.label);
        if (num === null) continue;
        const confidence = (an.confidence != null && an.confidence > 0) ? an.confidence : 1.0;
        weightedSum += num * confidence;
        confidenceSum += confidence;
    }

    if (confidenceSum === 0) return null;

    const avgHumanScore = weightedSum / confidenceSum;
    const agreement = Math.abs(evalScore - avgHumanScore) <= 0.2;

    await db.execute(
        `INSERT INTO meta_evaluations (evaluator_type, conversation_id, eval_score, human_label, agreement) 
     VALUES (?, ?, ?, ?, ?)`,
        [
            evaluation.evaluator_version || 'v1',
            conversation_id,
            evalScore,
            String(avgHumanScore),
            agreement ? 1 : 0
        ]
    );

    return { evalScore, avgHumanScore, agreement };
};

// ─── Calibration report (unchanged logic, cleaner structure) ─────────────────
module.exports.getCalibrationReport = async (evaluator_type, days) => {
    let query = 'SELECT * FROM meta_evaluations WHERE 1=1';
    const params = [];

    if (evaluator_type) {
        query += ' AND evaluator_type = ?';
        params.push(evaluator_type);
    }
    if (days) {
        query += ' AND created_at >= DATE_SUB(NOW(), INTERVAL ? DAY)';
        params.push(String(days));
    }

    const rows = await db.execute(query, params);

    if (rows.length === 0) {
        return { total_comparisons: 0, agreement_rate: 0, avg_eval_score: 0, avg_human_score: 0, drift: 0, evaluator_type: evaluator_type || 'all' };
    }

    let agreements = 0;
    let totalEval = 0;
    let totalHuman = 0;

    for (const r of rows) {
        if (r.agreement) agreements++;
        totalEval += r.eval_score;
        const h = parseFloat(r.human_label);
        totalHuman += isNaN(h) ? 0 : h;
    }

    const avg_eval_score = totalEval / rows.length;
    const avg_human_score = totalHuman / rows.length;
    const drift = Math.abs(avg_eval_score - avg_human_score);

    return {
        total_comparisons: rows.length,
        agreement_rate: agreements / rows.length,
        avg_eval_score,
        avg_human_score,
        drift,
        evaluator_type: evaluator_type || 'all'
    };
};

// ─── Drift alerts ────────────────────────────────────────────────────────────
module.exports.getDriftAlerts = async (threshold = 0.15) => {
    const typesRaw = await db.execute('SELECT DISTINCT evaluator_type FROM meta_evaluations');
    const alerts = [];

    for (const r of typesRaw) {
        const report = await module.exports.getCalibrationReport(r.evaluator_type);
        if (report.drift > threshold) {
            alerts.push({
                evaluator_type: r.evaluator_type,
                drift: report.drift,
                threshold,
                alert: `Drift of ${report.drift.toFixed(3)} exceeds threshold ${threshold}`
            });
        }
    }
    return alerts;
};

// ─── Fix 2: Per-category precision / recall / F1 ────────────────────────────
module.exports.getAccuracyReport = async (days) => {
    // Fetch all evaluated conversations that also have annotations
    let evalQuery = 'SELECT e.conversation_id, e.scores, a.annotation_type, a.label, a.confidence FROM evaluations e INNER JOIN annotations a ON e.conversation_id = a.conversation_id';
    const params = [];
    if (days) {
        evalQuery += ' WHERE e.created_at >= DATE_SUB(NOW(), INTERVAL ? DAY)';
        params.push(String(days));
    }

    const rows = await db.execute(evalQuery, params);
    if (!rows.length) {
        return { per_category: [], overall: { precision: 0, recall: 0, f1: 0 }, total_comparisons: 0 };
    }

    // Group by annotation type
    const categories = {};

    for (const row of rows) {
        const annoType = row.annotation_type;
        const evalKey = ANNOTATION_TO_EVAL_KEY[annoType];
        if (!evalKey) continue; // skip annotation types we can't map

        let scores = {};
        try {
            scores = typeof row.scores === 'string' ? JSON.parse(row.scores) : row.scores;
        } catch (e) { continue; }

        const evalDimScore = scores[evalKey];
        if (evalDimScore === null || evalDimScore === undefined) continue;

        const humanScore = mapLabelToNumeric(row.label);
        if (humanScore === null) continue;

        if (!categories[annoType]) {
            categories[annoType] = { tp: 0, fp: 0, fn: 0, tn: 0 };
        }

        const evalPositive = evalDimScore >= 0.5;
        const humanPositive = humanScore >= 0.5;

        if (evalPositive && humanPositive)  categories[annoType].tp++;
        if (evalPositive && !humanPositive) categories[annoType].fp++;
        if (!evalPositive && humanPositive) categories[annoType].fn++;
        if (!evalPositive && !humanPositive) categories[annoType].tn++;
    }

    // Compute metrics per category
    const per_category = [];
    let totalTP = 0, totalFP = 0, totalFN = 0, totalTN = 0;

    for (const [type, c] of Object.entries(categories)) {
        const precision = (c.tp + c.fp) > 0 ? c.tp / (c.tp + c.fp) : 0;
        const recall    = (c.tp + c.fn) > 0 ? c.tp / (c.tp + c.fn) : 0;
        const f1        = (precision + recall) > 0 ? 2 * (precision * recall) / (precision + recall) : 0;

        per_category.push({
            annotation_type: type,
            eval_dimension: ANNOTATION_TO_EVAL_KEY[type],
            tp: c.tp, fp: c.fp, fn: c.fn, tn: c.tn,
            precision: +precision.toFixed(4),
            recall:    +recall.toFixed(4),
            f1:        +f1.toFixed(4),
            total:     c.tp + c.fp + c.fn + c.tn
        });

        totalTP += c.tp; totalFP += c.fp; totalFN += c.fn; totalTN += c.tn;
    }

    // Macro-average overall
    const overallPrecision = (totalTP + totalFP) > 0 ? totalTP / (totalTP + totalFP) : 0;
    const overallRecall    = (totalTP + totalFN) > 0 ? totalTP / (totalTP + totalFN) : 0;
    const overallF1        = (overallPrecision + overallRecall) > 0
        ? 2 * (overallPrecision * overallRecall) / (overallPrecision + overallRecall) : 0;

    return {
        per_category,
        overall: {
            precision: +overallPrecision.toFixed(4),
            recall:    +overallRecall.toFixed(4),
            f1:        +overallF1.toFixed(4)
        },
        total_comparisons: totalTP + totalFP + totalFN + totalTN
    };
};

// ─── Fix 3: Drift auto-correction ───────────────────────────────────────────
module.exports.computeDriftCorrections = async (threshold = 0.15) => {
    const typesRaw = await db.execute('SELECT DISTINCT evaluator_type FROM meta_evaluations');
    const corrections = [];

    for (const r of typesRaw) {
        const report = await module.exports.getCalibrationReport(r.evaluator_type);

        if (report.drift > threshold && report.avg_eval_score > 0) {
            const correction_factor = report.avg_human_score / report.avg_eval_score;

            // Persist the correction
            await db.execute(
                `INSERT INTO drift_corrections (evaluator_type, correction_factor, drift_at_time, sample_size) VALUES (?, ?, ?, ?)`,
                [r.evaluator_type, correction_factor, report.drift, report.total_comparisons]
            );

            corrections.push({
                evaluator_type: r.evaluator_type,
                correction_factor: +correction_factor.toFixed(4),
                drift: +report.drift.toFixed(4),
                direction: report.avg_eval_score > report.avg_human_score ? 'evaluator_overscores' : 'evaluator_underscores',
                recommendation: report.avg_eval_score > report.avg_human_score
                    ? `Evaluator scores ${(report.drift * 100).toFixed(1)}% higher than human consensus. Apply correction factor ${correction_factor.toFixed(3)} to reduce scores.`
                    : `Evaluator scores ${(report.drift * 100).toFixed(1)}% lower than human consensus. Apply correction factor ${correction_factor.toFixed(3)} to boost scores.`,
                sample_size: report.total_comparisons
            });
        }
    }

    return { corrections, threshold };
};

// Get the latest correction factor for an evaluator type (used by the evaluator)
module.exports.getLatestCorrection = async (evaluator_type) => {
    const row = await db.queryOne(
        'SELECT correction_factor FROM drift_corrections WHERE evaluator_type = ? ORDER BY created_at DESC LIMIT 1',
        [evaluator_type]
    );
    return row ? row.correction_factor : 1.0;
};

module.exports.mapLabelToNumeric = mapLabelToNumeric;
module.exports.ANNOTATION_TO_EVAL_KEY = ANNOTATION_TO_EVAL_KEY;
