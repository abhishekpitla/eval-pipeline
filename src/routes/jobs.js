const express = require('express');
const router  = express.Router();
const db      = require('../db');

// GET /api/jobs/:id — check status of an async job
router.get('/:id', async (req, res) => {
    try {
        const job = await db.queryOne('SELECT * FROM jobs WHERE id = ?', [req.params.id]);
        if (!job) return res.status(404).json({ error: 'Job not found' });

        const response = {
            id:           job.id,
            type:         job.type,
            status:       job.status,
            created_at:   job.created_at,
            started_at:   job.started_at  || null,
            completed_at: job.completed_at || null
        };

        if (job.status === 'completed') {
            response.result = typeof job.result === 'string' ? JSON.parse(job.result) : job.result;
        }
        if (job.status === 'failed') {
            response.error = job.error;
        }

        res.json(response);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// GET /api/jobs — list recent jobs (optional ?type= and ?status= filters)
router.get('/', async (req, res) => {
    try {
        const { type, status } = req.query;
        const limit = parseInt(req.query.limit) || 20;

        let query  = 'SELECT id, type, status, created_at, started_at, completed_at FROM jobs WHERE 1=1';
        const params = [];

        if (type)   { query += ' AND type = ?';   params.push(type); }
        if (status) { query += ' AND status = ?'; params.push(status); }

        query += ' ORDER BY created_at DESC LIMIT ?';
        params.push(String(limit));

        const jobs = await db.execute(query, params);
        res.json(jobs);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

module.exports = router;
