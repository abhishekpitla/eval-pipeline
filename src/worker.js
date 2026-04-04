/**
 * worker.js
 *
 * Async job processor. Runs separately from the API server.
 * Polls the `jobs` table every POLL_INTERVAL ms and processes pending jobs.
 *
 * Start with:  node src/worker.js
 *
 * Handles three job types:
 *   evaluation        — evaluate a single conversation
 *   batch_evaluation  — evaluate multiple conversations (by IDs or agent_version)
 *   suggestion_cycle  — mine patterns and generate GPT-4o suggestions
 */

require('dotenv').config();

const db = require('./db');
const { evaluateConversation } = require('./evaluators/index');
const calibration = require('./meta/calibration');
const generator = require('./suggestions/generator');

const POLL_INTERVAL = 3000; // ms between polls
const LOCK_TIMEOUT  = 300;  // seconds — jobs stuck in 'processing' longer than this are retried

// ─── Claim a single pending job (atomic via UPDATE + SELECT) ─────────────────
async function claimJob() {
    // Mark one pending job as 'processing' atomically
    await db.execute(
        `UPDATE jobs
         SET status = 'processing', started_at = NOW()
         WHERE status = 'pending'
         ORDER BY created_at ASC
         LIMIT 1`
    );

    // Fetch the job we just claimed (most recently started)
    return db.queryOne(
        `SELECT * FROM jobs
         WHERE status = 'processing'
         ORDER BY started_at DESC
         LIMIT 1`
    );
}

// ─── Re-queue jobs stuck in 'processing' past the lock timeout ───────────────
async function requeueStalledJobs() {
    await db.execute(
        `UPDATE jobs
         SET status = 'pending', started_at = NULL
         WHERE status = 'processing'
           AND started_at < DATE_SUB(NOW(), INTERVAL ? SECOND)`,
        [String(LOCK_TIMEOUT)]
    );
}

// ─── Mark a job complete or failed ───────────────────────────────────────────
async function finalizeJob(id, status, resultOrError) {
    const isError = status === 'failed';
    await db.execute(
        `UPDATE jobs
         SET status = ?, completed_at = NOW(),
             result = ?, error = ?
         WHERE id = ?`,
        [
            status,
            isError ? null        : JSON.stringify(resultOrError),
            isError ? String(resultOrError) : null,
            id
        ]
    );
}

// ─── Job handlers ─────────────────────────────────────────────────────────────

async function handleEvaluation(payload) {
    const conv = await db.queryOne('SELECT * FROM conversations WHERE id = ?', [payload.conversation_id]);
    if (!conv) throw new Error(`Conversation ${payload.conversation_id} not found`);
    const result = await evaluateConversation(conv);
    try {
        const cal = await calibration.compareEvalToHuman(payload.conversation_id);
        if (cal) result.calibration = cal;
    } catch (_) { /* no annotations */ }
    return result;
}

async function handleBatchEvaluation(payload) {
    let query  = 'SELECT * FROM conversations';
    let params = [];

    if (payload.conversation_ids?.length) {
        const placeholders = payload.conversation_ids.map(() => '?').join(',');
        query  += ` WHERE id IN (${placeholders})`;
        params  = payload.conversation_ids;
    } else if (payload.agent_version) {
        query  += ' WHERE agent_version = ?';
        params  = [payload.agent_version];
    } else {
        throw new Error('Batch job requires conversation_ids or agent_version');
    }

    const conversations = await db.execute(query, params);
    const results = [];
    const errors  = [];

    // Process sequentially to avoid hammering the GPT-4o rate limit
    for (const conv of conversations) {
        try {
            const result = await evaluateConversation(conv);
            try {
                const cal = await calibration.compareEvalToHuman(conv.id);
                if (cal) result.calibration = cal;
            } catch (_) { /* no annotations */ }
            results.push(result);
        } catch (err) {
            errors.push({ conversation_id: conv.id, error: err.message });
        }
    }

    return { evaluated: results.length, results, errors };
}

async function handleSuggestionCycle(payload) {
    const days = payload.days || 7;
    return generator.runSuggestionCycle(days);
}

// ─── Main poll loop ───────────────────────────────────────────────────────────

async function processOne() {
    await requeueStalledJobs();

    const job = await claimJob();
    if (!job) return; // nothing pending

    console.log(`[worker] Processing job ${job.id} (type: ${job.type})`);

    const payload = typeof job.payload === 'string' ? JSON.parse(job.payload) : job.payload;

    try {
        let result;
        if (job.type === 'evaluation')        result = await handleEvaluation(payload);
        else if (job.type === 'batch_evaluation') result = await handleBatchEvaluation(payload);
        else if (job.type === 'suggestion_cycle') result = await handleSuggestionCycle(payload);
        else throw new Error(`Unknown job type: ${job.type}`);

        await finalizeJob(job.id, 'completed', result);
        console.log(`[worker] ✓ Job ${job.id} completed`);
    } catch (err) {
        await finalizeJob(job.id, 'failed', err.message);
        console.error(`[worker] ✗ Job ${job.id} failed: ${err.message}`);
    }
}

async function poll() {
    try {
        await processOne();
    } catch (err) {
        console.error('[worker] Unexpected poll error:', err.message);
    }
    setTimeout(poll, POLL_INTERVAL);
}

console.log(`[worker] Started. Polling every ${POLL_INTERVAL}ms...`);
poll();
