const express = require('express');
const router  = express.Router();
const { v4: uuidv4 } = require('uuid');
const db = require('../db');
const { evaluateConversation } = require('../evaluators/index');
const calibration = require('../meta/calibration');

// ─── Helper: enqueue a job ────────────────────────────────────────────────────
async function enqueue(type, payload) {
    const id = uuidv4();
    await db.execute(
        `INSERT INTO jobs (id, type, payload) VALUES (?, ?, ?)`,
        [id, type, JSON.stringify(payload)]
    );
    return id;
}

// GET /api/evaluations
router.get('/', async (req, res) => {
    try {
        const limit     = parseInt(req.query.limit)     || 10;
        const offset    = parseInt(req.query.offset)    || 0;
        const min_score = parseFloat(req.query.min_score);
        const max_score = parseFloat(req.query.max_score);

        let query      = 'SELECT * FROM evaluations WHERE 1=1';
        let countQuery = 'SELECT COUNT(*) as count FROM evaluations WHERE 1=1';
        const params   = [];

        if (!isNaN(min_score)) {
            query      += ' AND JSON_EXTRACT(scores, "$.overall") >= ?';
            countQuery += ' AND JSON_EXTRACT(scores, "$.overall") >= ?';
            params.push(min_score);
        }
        if (!isNaN(max_score)) {
            query      += ' AND JSON_EXTRACT(scores, "$.overall") <= ?';
            countQuery += ' AND JSON_EXTRACT(scores, "$.overall") <= ?';
            params.push(max_score);
        }

        query += ' ORDER BY created_at DESC LIMIT ? OFFSET ?';
        params.push(String(limit), String(offset));

        const countRaw = await db.execute(countQuery, params.slice(0, params.length - 2));
        const total    = countRaw[0] ? countRaw[0].count : 0;
        const evaluations = await db.execute(query, params);

        res.json({ evaluations, total, limit, offset });
    } catch (error) {
        res.status(500).json({ error: 'Internal server error' });
    }
});

// GET /api/evaluations/:conversation_id
router.get('/:conversation_id', async (req, res) => {
    try {
        const evals = await db.execute(
            'SELECT * FROM evaluations WHERE conversation_id = ? ORDER BY created_at DESC',
            [req.params.conversation_id]
        );
        res.json(evals);
    } catch (error) {
        res.status(500).json({ error: 'Internal server error' });
    }
});

// POST /api/evaluations/batch
// Default: async (returns job_id). Add ?realtime=true for synchronous response.
router.post('/batch', async (req, res) => {
    try {
        const { conversation_ids, agent_version } = req.body;

        if (!conversation_ids?.length && !agent_version) {
            return res.status(400).json({ error: 'Provide conversation_ids array or agent_version' });
        }

        // ── Realtime mode ─────────────────────────────────────────────────────
        if (req.query.realtime === 'true') {
            let query  = 'SELECT * FROM conversations';
            let params = [];

            if (conversation_ids?.length) {
                const placeholders = conversation_ids.map(() => '?').join(',');
                query  += ` WHERE id IN (${placeholders})`;
                params  = conversation_ids;
            } else {
                query  += ' WHERE agent_version = ?';
                params  = [agent_version];
            }

            const conversations = await db.execute(query, params);
            let evaluated = 0, results = [], errors = [];

            await Promise.all(conversations.map(async (conv) => {
                try {
                    const r = await evaluateConversation(conv);
                    try {
                        const cal = await calibration.compareEvalToHuman(conv.id);
                        if (cal) r.calibration = cal;
                    } catch (_) { /* no annotations */ }
                    results.push(r);
                    evaluated++;
                } catch (err) {
                    errors.push({ conversation_id: conv.id, error: err.message });
                }
            }));

            return res.json({ evaluated, results, errors });
        }

        // ── Async mode (default) ──────────────────────────────────────────────
        const job_id = await enqueue('batch_evaluation', { conversation_ids, agent_version });
        res.status(202).json({
            job_id,
            status: 'pending',
            message: 'Batch evaluation queued. Poll GET /api/jobs/:job_id for results.'
        });
    } catch (error) {
        console.error('Batch evaluation error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// POST /api/evaluations/:conversation_id
// Default: async (returns job_id). Add ?realtime=true for synchronous response.
router.post('/:conversation_id', async (req, res) => {
    try {
        const conv = await db.queryOne('SELECT * FROM conversations WHERE id = ?', [req.params.conversation_id]);
        if (!conv) return res.status(404).json({ error: 'Conversation not found' });

        // ── Realtime mode ─────────────────────────────────────────────────────
        if (req.query.realtime === 'true') {
            const result = await evaluateConversation(conv);
            // Attach calibration comparison if human annotations exist
            try {
                const cal = await calibration.compareEvalToHuman(req.params.conversation_id);
                if (cal) result.calibration = cal;
            } catch (_) { /* no annotations — skip */ }
            return res.json(result);
        }

        // ── Async mode (default) ──────────────────────────────────────────────
        const job_id = await enqueue('evaluation', { conversation_id: req.params.conversation_id });
        res.status(202).json({
            job_id,
            status: 'pending',
            message: 'Evaluation queued. Poll GET /api/jobs/:job_id for results.'
        });
    } catch (error) {
        console.error('Evaluation error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

module.exports = router;
