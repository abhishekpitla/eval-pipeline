const express = require('express');
const router = express.Router();
const db = require('../db');

// POST /api/feedback
router.post('/', async (req, res) => {
    try {
        const { conversation_id, annotator_id, annotation_type, label, confidence, notes } = req.body;

        if (!conversation_id || !annotator_id || !annotation_type || !label) {
            return res.status(400).json({ error: 'Missing required fields' });
        }

        // Insert into annotations table
        const result = await db.execute(
            `INSERT INTO annotations (conversation_id, annotator_id, annotation_type, label, confidence, notes) 
       VALUES (?, ?, ?, ?, ?, ?)`,
            [
                conversation_id,
                annotator_id,
                annotation_type,
                label,
                confidence || null,
                notes || null
            ]
        );

        const annotationId = result.insertId;

        // Fetch the new annotation to return
        const newAnnotation = await db.queryOne('SELECT * FROM annotations WHERE id = ?', [annotationId]);

        // Also merge into conversations.feedback JSON
        const conv = await db.queryOne('SELECT id, feedback FROM conversations WHERE id = ?', [conversation_id]);

        if (conv) {
            // In MySQL, JSON columns are natively object literals when parsed.
            let feedback = conv.feedback || {};
            if (typeof feedback === 'string') {
                try {
                    feedback = JSON.parse(feedback);
                } catch (e) {
                    feedback = {};
                }
            }

            if (!feedback.annotations) {
                feedback.annotations = [];
            }
            feedback.annotations.push({
                type: annotation_type,
                label,
                annotator_id
            });

            await db.execute(
                'UPDATE conversations SET feedback = ? WHERE id = ?',
                [JSON.stringify(feedback), conversation_id]
            );
        }

        res.status(201).json(newAnnotation);
    } catch (error) {
        console.error('Error adding feedback:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// GET /api/feedback/:conversation_id
router.get('/:conversation_id', async (req, res) => {
    try {
        const annotations = await db.execute(
            'SELECT * FROM annotations WHERE conversation_id = ? ORDER BY created_at DESC',
            [req.params.conversation_id]
        );
        res.json(annotations);
    } catch (error) {
        console.error('Error fetching annotations:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

module.exports = router;
