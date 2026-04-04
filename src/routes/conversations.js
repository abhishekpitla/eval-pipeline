const express = require('express');
const router = express.Router();
const db = require('../db');

// GET /api/conversations
router.get('/', async (req, res) => {
    try {
        const limit = parseInt(req.query.limit) || 10;
        const offset = parseInt(req.query.offset) || 0;
        const agent_version = req.query.agent_version;

        let query = 'SELECT * FROM conversations';
        let countQuery = 'SELECT COUNT(*) as count FROM conversations';
        let params = [];

        if (agent_version) {
            query += ' WHERE agent_version = ?';
            countQuery += ' WHERE agent_version = ?';
            params.push(agent_version);
        }

        query += ' ORDER BY created_at DESC LIMIT ? OFFSET ?';
        params.push(String(limit), String(offset));

        const countResult = await db.queryOne(countQuery, agent_version ? [agent_version] : []);
        const total = countResult.count;

        const conversations = await db.execute(query, params);

        res.json({
            conversations,
            total,
            limit,
            offset
        });
    } catch (error) {
        console.error('Error fetching conversations:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// POST /api/conversations
router.post('/', async (req, res) => {
    try {
        let convs = req.body;
        if (!Array.isArray(convs)) {
            convs = [convs];
        }

        let ingested = 0;
        let errors = [];

        for (let i = 0; i < convs.length; i++) {
            const conv = convs[i];
            if (!conv.conversation_id || !conv.agent_version || !conv.turns) {
                errors.push({ index: i, error: 'Missing required fields' });
                continue;
            }

            const id = conv.conversation_id;
            const agent_version = conv.agent_version;
            const turns = JSON.stringify(conv.turns);
            const feedback = conv.feedback ? JSON.stringify(conv.feedback) : JSON.stringify({});
            const metadata = conv.metadata ? JSON.stringify(conv.metadata) : JSON.stringify({});

            try {
                await db.execute(
                    `INSERT INTO conversations (id, agent_version, turns, feedback, metadata)
           VALUES (?, ?, ?, ?, ?)
           ON DUPLICATE KEY UPDATE
           agent_version = VALUES(agent_version),
           turns = VALUES(turns),
           feedback = VALUES(feedback),
           metadata = VALUES(metadata)`,
                    [id, agent_version, turns, feedback, metadata]
                );

                // Auto-persist annotations from feedback.annotations into the annotations table
                const annotations = conv.feedback?.annotations;
                if (Array.isArray(annotations)) {
                    for (const ann of annotations) {
                        if (!ann.annotator_id || !ann.type || !ann.label) continue;
                        await db.execute(
                            `INSERT IGNORE INTO annotations (conversation_id, annotator_id, annotation_type, label, confidence, notes)
                             VALUES (?, ?, ?, ?, ?, ?)`,
                            [id, ann.annotator_id, ann.type, ann.label, ann.confidence ?? null, ann.notes ?? null]
                        );
                    }
                }

                ingested++;
            } catch (err) {
                errors.push({ index: i, error: err.message });
            }
        }

        res.status(201).json({ ingested, errors });
    } catch (error) {
        console.error('Error ingesting conversations:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// GET /api/conversations/:id
router.get('/:id', async (req, res) => {
    try {
        const conv = await db.queryOne('SELECT * FROM conversations WHERE id = ?', [req.params.id]);
        if (!conv) {
            return res.status(404).json({ error: 'Conversation not found' });
        }
        res.json(conv);
    } catch (error) {
        console.error('Error fetching conversation:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// GET /api/conversations/:id/stats
router.get('/:id/stats', async (req, res) => {
    try {
        const conv = await db.queryOne('SELECT * FROM conversations WHERE id = ?', [req.params.id]);
        if (!conv) {
            return res.status(404).json({ error: 'Conversation not found' });
        }

        const turns = conv.turns || [];
        const metadata = conv.metadata || {};
        const feedback = conv.feedback || {};

        let user_turns = 0;
        let assistant_turns = 0;
        let tool_call_count = 0;
        let tool_success_count = 0;

        for (const turn of turns) {
            if (turn.role === 'user') user_turns++;
            if (turn.role === 'assistant') assistant_turns++;

            if (turn.tool_calls && Array.isArray(turn.tool_calls)) {
                for (const call of turn.tool_calls) {
                    tool_call_count++;
                    if (call.result && !call.result.error) {
                        tool_success_count++;
                    }
                }
            }
        }

        const tool_success_rate = tool_call_count > 0 ? (tool_success_count / tool_call_count) : 0;

        res.json({
            turn_count: turns.length,
            user_turns,
            assistant_turns,
            tool_call_count,
            tool_success_rate,
            user_rating: feedback.user_rating || null,
            mission_completed: metadata.mission_completed || false,
            total_latency_ms: metadata.total_latency_ms || 0
        });
    } catch (error) {
        console.error('Error fetching conversation stats:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

module.exports = router;
