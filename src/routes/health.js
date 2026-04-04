const express = require('express');
const router = express.Router();
const db = require('../db');

router.get('/', async (req, res) => {
    let dbStatus = false;
    try {
        const result = await db.queryOne('SELECT 1');
        if (result) dbStatus = true;
    } catch (error) {
        dbStatus = false;
    }

    res.json({
        status: 'ok',
        db: dbStatus,
        timestamp: new Date().toISOString()
    });
});

module.exports = router;
