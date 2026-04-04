const express = require('express');
const router  = express.Router();
const { v4: uuidv4 } = require('uuid');
const generator = require('../suggestions/generator');
const db = require('../db');

// POST /api/suggestions/generate
// Default: async (returns job_id). Add ?realtime=true for synchronous response.
router.post('/generate', async (req, res) => {
    try {
        const days = parseInt(req.query.days) || 7;

        // ── Realtime mode ─────────────────────────────────────────────────────
        if (req.query.realtime === 'true') {
            const summary = await generator.runSuggestionCycle(days);
            return res.json(summary);
        }

        // ── Async mode (default) ──────────────────────────────────────────────
        const id = uuidv4();
        await db.execute(
            `INSERT INTO jobs (id, type, payload) VALUES (?, ?, ?)`,
            [id, 'suggestion_cycle', JSON.stringify({ days })]
        );
        res.status(202).json({
            job_id: id,
            status: 'pending',
            message: 'Suggestion cycle queued. Poll GET /api/jobs/:job_id for results.'
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// GET /api/suggestions
router.get('/', async (req, res) => {
    try {
        const type = req.query.type;
        const status = req.query.status;
        const limit = parseInt(req.query.limit) || 10;

        let query = 'SELECT * FROM suggestions WHERE 1=1';
        let params = [];
        if (type) {
            query += ' AND type = ?';
            params.push(type);
        }
        if (status) {
            query += ' AND status = ?';
            params.push(status);
        }
        query += ' ORDER BY created_at DESC LIMIT ? OFFSET 0';
        params.push(String(limit));

        const results = await db.execute(query, params);
        res.json(results);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// PATCH /api/suggestions/:id
router.patch('/:id', async (req, res) => {
    try {
        const { status } = req.body;
        if (!['pending', 'accepted', 'rejected', 'applied'].includes(status)) {
            return res.status(400).json({ error: 'Invalid status' });
        }

        await db.execute('UPDATE suggestions SET status = ? WHERE id = ?', [status, req.params.id]);
        const updated = await db.queryOne('SELECT * FROM suggestions WHERE id = ?', [req.params.id]);
        res.json(updated);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

module.exports = router;
