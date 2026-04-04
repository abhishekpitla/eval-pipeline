const express = require('express');
const router = express.Router();
const calibration = require('../meta/calibration');
const disagreement = require('../meta/disagreement');
const blindSpots = require('../meta/blindSpots');
const patternDetector = require('../suggestions/patternDetector');

// GET /api/meta/calibration
router.get('/calibration', async (req, res) => {
    try {
        const evaluator = req.query.evaluator_type;
        const days = parseInt(req.query.days) || undefined;
        const report = await calibration.getCalibrationReport(evaluator, days);
        res.json(report);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// GET /api/meta/drift
router.get('/drift', async (req, res) => {
    try {
        const threshold = parseFloat(req.query.threshold) || 0.15;
        const alerts = await calibration.getDriftAlerts(threshold);
        res.json(alerts);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// POST /api/meta/calibrate/:conversation_id
router.post('/calibrate/:conversation_id', async (req, res) => {
    try {
        const result = await calibration.compareEvalToHuman(req.params.conversation_id);
        if (!result) return res.status(404).json({ error: 'Unable to calibrate, data missing' });
        res.json(result);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// GET /api/meta/disagreements
router.get('/disagreements', async (req, res) => {
    try {
        const days = parseInt(req.query.days) || undefined;
        const results = await disagreement.getDisputedConversations(days);
        res.json(results);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// POST /api/meta/disagreements/resolve
router.post('/disagreements/resolve', async (req, res) => {
    try {
        const { conversation_id, annotation_type, resolved_label, resolver_id } = req.body;
        if (!conversation_id || !annotation_type || !resolved_label || !resolver_id) {
            return res.status(400).json({ error: 'Missing required parameters' });
        }
        const resolution = await disagreement.resolveDisagreement(conversation_id, annotation_type, resolved_label, resolver_id);
        res.json(resolution);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ─── NEW ENDPOINTS ───────────────────────────────────────────────────────────

// GET /api/meta/accuracy — Per-category precision/recall/F1
router.get('/accuracy', async (req, res) => {
    try {
        const days = parseInt(req.query.days) || undefined;
        const report = await calibration.getAccuracyReport(days);
        res.json(report);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// GET /api/meta/blind-spots — Detect evaluator blind spots
router.get('/blind-spots', async (req, res) => {
    try {
        const days = parseInt(req.query.days) || undefined;
        const threshold = parseFloat(req.query.threshold) || 0.7;
        const result = await blindSpots.detectBlindSpots(days, threshold);
        res.json(result);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// POST /api/meta/corrections — Compute and store drift corrections
router.post('/corrections', async (req, res) => {
    try {
        const threshold = parseFloat(req.query.threshold) || 0.15;
        const result = await calibration.computeDriftCorrections(threshold);
        res.json(result);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// GET /api/meta/corrections — Get latest drift correction factors
router.get('/corrections', async (req, res) => {
    try {
        const evaluator_type = req.query.evaluator_type || 'v4';
        const factor = await calibration.getLatestCorrection(evaluator_type);
        res.json({ evaluator_type, correction_factor: factor });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// GET /api/meta/regressions — Compare evaluation scores between two agent versions
router.get('/regressions', async (req, res) => {
    try {
        const { current, previous } = req.query;
        if (!current || !previous) {
            return res.status(400).json({ error: 'Both current and previous agent version query params are required' });
        }
        const regressions = await patternDetector.detectRegressions(current, previous);
        res.json(regressions);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

module.exports = router;
