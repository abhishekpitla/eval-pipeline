const db = require('../db');

module.exports.detectFailurePatterns = async (days, min_count = 1) => {
    let query = 'SELECT * FROM evaluations WHERE 1=1';
    const params = [];
    if (days) {
        query += ' AND created_at >= DATE_SUB(NOW(), INTERVAL ? DAY)';
        params.push(String(days));
    }
    const evals = await db.execute(query, params);

    const issueMap = {};
    for (const ev of evals) {
        let issues = [];
        try {
            issues = typeof ev.issues_detected === 'string' ? JSON.parse(ev.issues_detected) : (ev.issues_detected || []);
        } catch (e) { continue; }

        let scores = {};
        try {
            scores = typeof ev.scores === 'string' ? JSON.parse(ev.scores) : (ev.scores || {});
        } catch (e) { }

        for (const issue of issues) {
            const key = `${issue.type}::${issue.severity}`;
            if (!issueMap[key]) {
                issueMap[key] = {
                    issue_type: issue.type,
                    severity: issue.severity,
                    count: 0,
                    scores: [],
                    sample_conversation_ids: []
                };
            }
            issueMap[key].count++;
            if (issueMap[key].sample_conversation_ids.length < 5) {
                if (!issueMap[key].sample_conversation_ids.includes(ev.conversation_id)) {
                    issueMap[key].sample_conversation_ids.push(ev.conversation_id);
                }
            }
            if (scores.overall !== undefined) {
                issueMap[key].scores.push(scores.overall);
            }
        }
    }

    const results = [];
    const totalEvals = evals.length;
    for (const v of Object.values(issueMap)) {
        if (v.count >= min_count) {
            results.push({
                issue_type: v.issue_type,
                severity: v.severity,
                count: v.count,
                percentage: totalEvals > 0 ? (v.count / totalEvals) : 0,
                sample_conversation_ids: v.sample_conversation_ids,
                avg_score_for_affected: v.scores.length > 0 ? (v.scores.reduce((a, b) => a + b, 0) / v.scores.length) : 0
            });
        }
    }

    results.sort((a, b) => b.count - a.count);
    return results;
};

module.exports.detectToolPatterns = async (days) => {
    let query = 'SELECT * FROM evaluations WHERE 1=1';
    const params = [];
    if (days) {
        query += ' AND created_at >= DATE_SUB(NOW(), INTERVAL ? DAY)';
        params.push(String(days));
    }
    const evals = await db.execute(query, params);

    const stats = {};
    for (const ev of evals) {
        let issues = [];
        try {
            issues = typeof ev.issues_detected === 'string' ? JSON.parse(ev.issues_detected) : (ev.issues_detected || []);
        } catch (e) { }

        for (const issue of issues) {
            if (issue.type === 'missing_parameter' || issue.type === 'unknown_tool' || issue.type === 'execution_failure') {
                const match = issue.message.match(/Tool\s+(\w+)\s+/);
                const tool = match ? match[1] : 'unknown';

                if (!stats[tool]) stats[tool] = { tool_name: tool, failures: 0, missing_params: 0, executions: 0 };
                stats[tool].failures++;
                if (issue.type === 'missing_parameter') stats[tool].missing_params++;
            }
        }
    }

    const res = Object.values(stats);
    res.sort((a, b) => b.failures - a.failures);
    return res;
};

module.exports.detectRegressions = async (current_version, previous_version) => {
    const [curr, prev] = await Promise.all([
        db.execute('SELECT scores FROM evaluations WHERE conversation_id IN (SELECT id FROM conversations WHERE agent_version = ?)', [current_version]),
        db.execute('SELECT scores FROM evaluations WHERE conversation_id IN (SELECT id FROM conversations WHERE agent_version = ?)', [previous_version])
    ]);

    const getAvgs = (rows) => {
        let c = { heuristic: 0, toolCall: 0, llmJudge: 0, coherence: 0, overall: 0 };
        if (!rows.length) return c;
        for (const r of rows) {
            let s = {};
            try { s = typeof r.scores === 'string' ? JSON.parse(r.scores) : r.scores; } catch (e) { }
            c.heuristic += s.heuristic || 0;
            c.toolCall += s.toolCall || 0;
            c.llmJudge += s.llmJudge || 0;
            c.coherence += s.coherence || 0;
            c.overall += s.overall || 0;
        }
        for (let k in c) c[k] = c[k] / rows.length;
        return c;
    };

    const currAvgs = getAvgs(curr);
    const prevAvgs = getAvgs(prev);

    const metrics = ['heuristic', 'toolCall', 'llmJudge', 'coherence', 'overall'];
    const regressions = [];
    for (const m of metrics) {
        const delta = currAvgs[m] - prevAvgs[m];
        regressions.push({
            metric: m,
            current_avg: currAvgs[m],
            previous_avg: prevAvgs[m],
            delta,
            is_regression: delta < -0.05
        });
    }
    return regressions;
};
