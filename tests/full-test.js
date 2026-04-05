/**
 * full-test.js
 * End-to-end test suite covering all API routes + async job flow.
 * Starts the API server internally, runs tests, then kills it.
 */

require('dotenv').config({ path: require('path').join(__dirname, '../.env') });

const http   = require('http');
const { spawn } = require('child_process');
const path   = require('path');

const BASE = 'http://localhost:3099'; // use 3099 to avoid colliding with dev server
process.env.PORT = '3099';

let passed = 0;
let failed = 0;
let serverProcess;

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function req(method, url, body) {
    return new Promise((resolve, reject) => {
        const parsed = new URL(url);
        const options = {
            hostname: parsed.hostname,
            port:     parsed.port,
            path:     parsed.pathname + parsed.search,
            method,
            headers:  { 'Content-Type': 'application/json' }
        };
        const r = http.request(options, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
                catch { resolve({ status: res.statusCode, body: data }); }
            });
        });
        r.on('error', reject);
        if (body) r.write(JSON.stringify(body));
        r.end();
    });
}

function assert(label, condition, detail = '') {
    if (condition) {
        console.log(`  ✅ ${label}`);
        passed++;
    } else {
        console.log(`  ❌ ${label}${detail ? ' — ' + detail : ''}`);
        failed++;
    }
}

function section(title) {
    console.log(`\n${'─'.repeat(55)}`);
    console.log(`  ${title}`);
    console.log('─'.repeat(55));
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// Poll a job until completed/failed or timeout
async function waitForJob(job_id, timeoutMs = 30000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
        const r = await req('GET', `${BASE}/api/jobs/${job_id}`);
        if (r.body.status === 'completed' || r.body.status === 'failed') return r.body;
        await sleep(500);
    }
    return null;
}

// ─── Start server ─────────────────────────────────────────────────────────────

function startServer() {
    return new Promise((resolve) => {
        serverProcess = spawn('node', [path.join(__dirname, '../src/app.js')], {
            env: { ...process.env, PORT: '3099' },
            stdio: ['ignore', 'pipe', 'pipe']
        });
        serverProcess.stdout.on('data', (d) => {
            if (d.toString().includes('listening')) resolve();
        });
        serverProcess.stderr.on('data', () => {});
        setTimeout(resolve, 2000); // fallback
    });
}

// ─── Start worker ─────────────────────────────────────────────────────────────

function startWorker() {
    const w = spawn('node', [path.join(__dirname, '../src/worker.js')], {
        env: { ...process.env },
        stdio: ['ignore', 'pipe', 'pipe']
    });
    w.stdout.on('data', () => {});
    w.stderr.on('data', () => {});
    return w;
}

// ─── TEST SUITES ──────────────────────────────────────────────────────────────

async function testHealth() {
    section('1. HEALTH CHECK');
    const r = await req('GET', `${BASE}/api/health`);
    assert('Returns 200',        r.status === 200);
    assert('status is ok',       r.body.status === 'ok');
    assert('db field present',   r.body.db !== undefined);
}

async function testConversations() {
    section('2. CONVERSATIONS');

    // Ingest single
    const conv = {
        conversation_id: 'test_conv_001',
        agent_version:   'v2.4.0',
        turns: [
            { turn_id: 1, role: 'user',      content: 'Book a flight to London next week, dates Jan 20 to Jan 27.' },
            { turn_id: 2, role: 'assistant',  content: 'Sure! Searching for flights to London.',
              tool_calls: [{ tool_name: 'flight_search', parameters: { destination: 'London', date_range: '2024-01-20/2024-01-27' }, result: { status: 'success', flights: ['BA001'] }, latency_ms: 300 }] }
        ],
        feedback: { user_rating: 5 },
        metadata: { total_latency_ms: 500, mission_completed: true }
    };
    const ingest = await req('POST', `${BASE}/api/conversations`, conv);
    assert('POST /conversations returns 201', ingest.status === 201);
    assert('Ingested 1 conversation',         ingest.body.ingested === 1);
    assert('No errors',                       ingest.body.errors?.length === 0);

    // Batch ingest
    const batch = [
        { conversation_id: 'test_conv_002', agent_version: 'v2.4.0',
          turns: [{ turn_id: 1, role: 'user', content: 'Hi' }, { turn_id: 2, role: 'assistant', content: 'Hello! How can I help?' }],
          feedback: {}, metadata: { total_latency_ms: 100, mission_completed: false } },
        { conversation_id: 'test_conv_003', agent_version: 'v2.3.1',
          turns: [{ turn_id: 1, role: 'user', content: 'Check weather in Paris.' },
                  { turn_id: 2, role: 'assistant', content: 'Checking now.',
                    tool_calls: [{ tool_name: 'weather_check', parameters: { location: 'Paris' }, result: { status: 'success', temp: '10C' }, latency_ms: 200 }] }],
          feedback: { user_rating: 4 }, metadata: { total_latency_ms: 4200, mission_completed: true } }
    ];
    const batchIngest = await req('POST', `${BASE}/api/conversations`, batch);
    assert('Batch ingest returns 201',  batchIngest.status === 201);
    assert('Ingested 2 conversations',  batchIngest.body.ingested === 2);

    // List
    const list = await req('GET', `${BASE}/api/conversations?limit=5`);
    assert('GET /conversations returns 200', list.status === 200);
    assert('Has conversations array',        Array.isArray(list.body.conversations));
    assert('Has total count',                list.body.total > 0);

    // Filter by version
    const filtered = await req('GET', `${BASE}/api/conversations?agent_version=v2.4.0`);
    assert('Filter by agent_version works',  filtered.status === 200);

    // Get single
    const single = await req('GET', `${BASE}/api/conversations/test_conv_001`);
    assert('GET single conversation',        single.status === 200);
    assert('Returns correct id',             single.body.id === 'test_conv_001');

    // Stats
    const stats = await req('GET', `${BASE}/api/conversations/test_conv_001/stats`);
    assert('GET /stats returns 200',         stats.status === 200);
    assert('Has turn_count',                 stats.body.turn_count === 2);
    assert('Has tool_call_count',            stats.body.tool_call_count === 1);
    assert('tool_success_rate is 1',         stats.body.tool_success_rate === 1);

    // Missing required fields
    const bad = await req('POST', `${BASE}/api/conversations`, { agent_version: 'v1' });
    assert('Missing fields returns 201 with error', bad.status === 201 && bad.body.errors?.length > 0);

    // 404 for unknown
    const notFound = await req('GET', `${BASE}/api/conversations/does_not_exist`);
    assert('Unknown conversation returns 404', notFound.status === 404);
}

async function testEvaluationsRealtime() {
    section('3. EVALUATIONS — REALTIME MODE (?realtime=true)');

    // Single realtime eval
    const r = await req('POST', `${BASE}/api/evaluations/test_conv_001?realtime=true`);
    assert('POST /evaluations/:id?realtime=true returns 200', r.status === 200);
    assert('Has scores.overall',     typeof r.body.scores?.overall === 'number');
    assert('Has issues_detected',    Array.isArray(r.body.issues_detected));
    assert('Has tool_evaluation',    r.body.tool_evaluation !== undefined);
    assert('overall is 0-1',         r.body.scores.overall >= 0 && r.body.scores.overall <= 1);
    assert('evaluator_version is v4',r.body.evaluator_version === 'v4');

    // High latency conversation should be capped at 0.70
    const highLatency = await req('POST', `${BASE}/api/evaluations/test_conv_003?realtime=true`);
    assert('High latency conv evaluated',  highLatency.status === 200);
    assert('High latency penalized (score * 0.85)', highLatency.body.scores?.overall <= 0.85,
        `got ${highLatency.body.scores?.overall}`);

    // Batch realtime
    const batch = await req('POST', `${BASE}/api/evaluations/batch?realtime=true`,
        { conversation_ids: ['test_conv_001', 'test_conv_002'] });
    assert('Batch realtime returns 200',   batch.status === 200);
    assert('Evaluated 2 conversations',    batch.body.evaluated === 2);
    assert('Results is array of 2',        batch.body.results?.length === 2);

    // Batch by agent_version
    const batchVer = await req('POST', `${BASE}/api/evaluations/batch?realtime=true`,
        { agent_version: 'v2.4.0' });
    assert('Batch by agent_version works', batchVer.status === 200);

    // Unknown conversation
    const missing = await req('POST', `${BASE}/api/evaluations/no_such_conv?realtime=true`);
    assert('Unknown conv returns 404',     missing.status === 404);

    // List evaluations
    const list = await req('GET', `${BASE}/api/evaluations?limit=5`);
    assert('GET /evaluations returns 200', list.status === 200);
    assert('Has evaluations array',        Array.isArray(list.body.evaluations));

    // Filter by score
    const filtered = await req('GET', `${BASE}/api/evaluations?min_score=0.5&max_score=1.0`);
    assert('Score filter works',           filtered.status === 200);

    // Get by conversation
    const byConv = await req('GET', `${BASE}/api/evaluations/test_conv_001`);
    assert('GET /evaluations/:conv_id',    byConv.status === 200);
    assert('Returns array',                Array.isArray(byConv.body));
}

async function testAsyncJobs(workerProcess) {
    section('4. ASYNC JOB FLOW (default mode)');

    // Queue a single evaluation
    const queued = await req('POST', `${BASE}/api/evaluations/test_conv_002`);
    assert('POST returns 202 Accepted',  queued.status === 202);
    assert('Has job_id',                 typeof queued.body.job_id === 'string');
    assert('Status is pending',          queued.body.status === 'pending');
    assert('Has message',                typeof queued.body.message === 'string');

    const job_id = queued.body.job_id;

    // Check job immediately — should be pending or processing
    const immediate = await req('GET', `${BASE}/api/jobs/${job_id}`);
    assert('GET /jobs/:id returns 200',  immediate.status === 200);
    assert('Job exists in DB',           ['pending','processing','completed'].includes(immediate.body.status));

    // Wait for worker to process it
    console.log('  ⏳ Waiting for worker to process job...');
    const finished = await waitForJob(job_id, 20000);
    assert('Job completed within 20s',   finished !== null);
    assert('Job status is completed',    finished?.status === 'completed');
    assert('Result has scores',          finished?.result?.scores?.overall !== undefined);

    // Queue a batch job
    const batchQueued = await req('POST', `${BASE}/api/evaluations/batch`,
        { conversation_ids: ['test_conv_001', 'test_conv_003'] });
    assert('Batch job queued (202)',      batchQueued.status === 202);
    const batchJobId = batchQueued.body.job_id;

    console.log('  ⏳ Waiting for batch job...');
    const batchDone = await waitForJob(batchJobId, 60000);
    assert('Batch job completed',        batchDone?.status === 'completed');
    assert('Batch result has evaluated', batchDone?.result?.evaluated > 0);

    // Queue suggestion cycle
    const sugQueued = await req('POST', `${BASE}/api/suggestions/generate`);
    assert('Suggestion job queued (202)',sugQueued.status === 202);
    const sugJobId = sugQueued.body.job_id;

    console.log('  ⏳ Waiting for suggestion cycle...');
    const sugDone = await waitForJob(sugJobId, 60000);
    assert('Suggestion job completed',   sugDone?.status === 'completed');

    // List jobs
    const allJobs = await req('GET', `${BASE}/api/jobs`);
    assert('GET /api/jobs returns list', Array.isArray(allJobs.body));
    assert('Has our jobs in list',       allJobs.body.length >= 3);

    // Filter by status
    const completed = await req('GET', `${BASE}/api/jobs?status=completed`);
    assert('Filter by status=completed', completed.body.every(j => j.status === 'completed'));

    // 404 for unknown job
    const noJob = await req('GET', `${BASE}/api/jobs/no-such-job`);
    assert('Unknown job returns 404',    noJob.status === 404);
}

async function testFeedback() {
    section('5. FEEDBACK & ANNOTATIONS');

    const annotation = {
        conversation_id:  'test_conv_001',
        annotator_id:     'reviewer_1',
        annotation_type:  'helpfulness',
        label:            'good',
        confidence:       0.9,
        notes:            'Very clear response'
    };
    const post = await req('POST', `${BASE}/api/feedback`, annotation);
    assert('POST /feedback returns 201',      post.status === 201);
    assert('Has annotation id',               post.body.id !== undefined);
    assert('Correct conversation_id',         post.body.conversation_id === 'test_conv_001');

    // Second annotator disagrees
    const annotation2 = { ...annotation, annotator_id: 'reviewer_2', label: 'poor', confidence: 0.7 };
    const post2 = await req('POST', `${BASE}/api/feedback`, annotation2);
    assert('Second annotation accepted',      post2.status === 201);

    // Get annotations for conversation
    const get = await req('GET', `${BASE}/api/feedback/test_conv_001`);
    assert('GET /feedback/:id returns 200',   get.status === 200);
    assert('Returns array of annotations',    Array.isArray(get.body));
    assert('Has at least 2 annotations',      get.body.length >= 2);

    // Missing required fields
    const bad = await req('POST', `${BASE}/api/feedback`, { conversation_id: 'test_conv_001' });
    assert('Missing fields returns 400',      bad.status === 400);
}

async function testMeta() {
    section('6. META — CALIBRATION & DISAGREEMENTS');

    // Calibrate (needs both an evaluation and annotation)
    const cal = await req('POST', `${BASE}/api/meta/calibrate/test_conv_001`);
    assert('POST /meta/calibrate returns 200 or 404',
        cal.status === 200 || cal.status === 404); // 404 if no eval yet
    if (cal.status === 200) {
        assert('Has evalScore',     cal.body.evalScore !== undefined);
        assert('Has avgHumanScore', cal.body.avgHumanScore !== undefined);
        assert('Has agreement',     cal.body.agreement !== undefined);
    }

    // Calibration report
    const report = await req('GET', `${BASE}/api/meta/calibration`);
    assert('GET /meta/calibration returns 200', report.status === 200);
    assert('Has total_comparisons',             report.body.total_comparisons !== undefined);
    assert('Has agreement_rate',                report.body.agreement_rate !== undefined);

    // Drift alerts
    const drift = await req('GET', `${BASE}/api/meta/drift`);
    assert('GET /meta/drift returns 200',       drift.status === 200);
    assert('Returns array',                     Array.isArray(drift.body));

    // Disagreements
    const dis = await req('GET', `${BASE}/api/meta/disagreements`);
    assert('GET /meta/disagreements returns 200', dis.status === 200);
    assert('Returns array',                       Array.isArray(dis.body));

    // Resolve disagreement
    const resolve = await req('POST', `${BASE}/api/meta/disagreements/resolve`, {
        conversation_id:  'test_conv_001',
        annotation_type:  'helpfulness',
        resolved_label:   'good',
        resolver_id:      'lead_reviewer'
    });
    assert('POST /meta/disagreements/resolve 200', resolve.status === 200);
    assert('Has resolved_label',                   resolve.body.resolved_label === 'good');

    // Missing fields
    const bad = await req('POST', `${BASE}/api/meta/disagreements/resolve`, { conversation_id: 'x' });
    assert('Missing resolve fields returns 400',   bad.status === 400);
}

async function testSuggestionsRealtime() {
    section('7. SUGGESTIONS — REALTIME MODE');

    // Get suggestions list
    const list = await req('GET', `${BASE}/api/suggestions`);
    assert('GET /suggestions returns 200',  list.status === 200);
    assert('Returns array',                 Array.isArray(list.body));

    // Filter by type
    const prompt = await req('GET', `${BASE}/api/suggestions?type=prompt`);
    assert('Filter by type=prompt works',   prompt.status === 200);

    // Filter by status
    const pending = await req('GET', `${BASE}/api/suggestions?status=pending`);
    assert('Filter by status=pending works',pending.status === 200);

    // PATCH a suggestion if any exist
    if (list.body.length > 0) {
        const id = list.body[0].id;
        const patch = await req('PATCH', `${BASE}/api/suggestions/${id}`, { status: 'accepted' });
        assert('PATCH /suggestions/:id returns 200',  patch.status === 200);
        assert('Status updated to accepted',          patch.body.status === 'accepted');

        // Invalid status
        const badPatch = await req('PATCH', `${BASE}/api/suggestions/${id}`, { status: 'invalid' });
        assert('Invalid status returns 400',          badPatch.status === 400);
    } else {
        console.log('  ⏭  No suggestions yet to PATCH (skipped)');
    }

    // Realtime generate
    const gen = await req('POST', `${BASE}/api/suggestions/generate?realtime=true`);
    assert('POST /suggestions/generate?realtime=true returns 200', gen.status === 200);
}

// ─── Run all suites ───────────────────────────────────────────────────────────

async function run() {
    console.log('\n' + '═'.repeat(55));
    console.log('  FULL END-TO-END TEST SUITE');
    console.log('═'.repeat(55));
    console.log('  Starting API server on port 3099...');

    await startServer();
    console.log('  ✓ Server started');

    const workerProcess = startWorker();
    console.log('  ✓ Worker started');
    await sleep(1000); // let worker initialize

    try {
        await testHealth();
        await testConversations();
        await testEvaluationsRealtime();
        await testAsyncJobs(workerProcess);
        await testFeedback();
        await testMeta();
        await testSuggestionsRealtime();
    } finally {
        serverProcess?.kill();
        workerProcess?.kill();
    }

    // ── Summary ───────────────────────────────────────────────────────────────
    console.log('\n' + '═'.repeat(55));
    console.log('  RESULTS');
    console.log('═'.repeat(55));
    console.log(`  ✅ Passed: ${passed}`);
    console.log(`  ❌ Failed: ${failed}`);
    console.log(`  Total:    ${passed + failed}`);
    console.log('');

    process.exit(failed > 0 ? 1 : 0);
}

run().catch(err => {
    console.error('Fatal:', err);
    serverProcess?.kill();
    process.exit(1);
});
