const { exec } = require('child_process');
const { v4: uuidv4 } = require('uuid');

async function testApi() {
    const baseUrl = 'http://localhost:3000/api';

    console.log('Building environment...');

    // Starting server locally inside the test because no test framework is used 
    // and we want it to run without making the user start it first separately
    console.log('Starting server...');
    const server = exec('node src/app.js');

    server.stdout.on('data', (d) => process.stdout.write('[Server] ' + d));
    server.stderr.on('data', (d) => process.stderr.write('[Server] ' + d));

    // wait 2 seconds for server to start
    await new Promise(resolve => setTimeout(resolve, 2000));

    try {
        console.log('\n--- Running Tests ---');

        // Test: health check
        const healthRes = await fetch(`${baseUrl}/health`);
        const healthJson = await healthRes.json();
        if (healthRes.status === 200 && healthJson.db === true) {
            console.log('✅ Test: health check returns 200 with db: true');
        } else {
            console.error('❌ Test: health check FAILED', healthJson);
            process.exitCode = 1;
        }

        // Test: POST single conversation
        const c1 = {
            conversation_id: uuidv4(),
            agent_version: 'v1.0.0',
            turns: [{ role: 'user', content: 'test single' }],
            feedback: { user_rating: 5 },
            metadata: { mission_completed: true }
        };

        const postSingleRes = await fetch(`${baseUrl}/conversations`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(c1)
        });
        const postSingleJson = await postSingleRes.json();
        if (postSingleJson.ingested === 1) {
            console.log('✅ Test: POST single conversation returns ingested: 1');
        } else {
            console.error('❌ Test: POST single conversation FAILED', postSingleJson);
            process.exitCode = 1;
        }

        // Test: POST batch of 3 conversations
        const batch = [
            { conversation_id: uuidv4(), agent_version: 'v1.0.0', turns: [] },
            { conversation_id: uuidv4(), agent_version: 'v1.0.0', turns: [] },
            { conversation_id: uuidv4(), agent_version: 'v1.0.0', turns: [] }
        ];
        const postBatchRes = await fetch(`${baseUrl}/conversations`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(batch)
        });
        const postBatchJson = await postBatchRes.json();
        if (postBatchJson.ingested === 3) {
            console.log('✅ Test: POST batch of 3 conversations returns ingested: 3');
        } else {
            console.error('❌ Test: POST batch FAILED', postBatchJson);
            process.exitCode = 1;
        }

        // Test: POST with missing fields returns errors
        const failBatch = { conversation_id: uuidv4() }; // missing agent_version and turns
        const paramFailRes = await fetch(`${baseUrl}/conversations`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(failBatch)
        });
        const paramFailJson = await paramFailRes.json();
        if (paramFailJson.errors && paramFailJson.errors.length > 0) {
            console.log('✅ Test: POST with missing fields returns errors');
        } else {
            console.error('❌ Test: missing fields FAILED', paramFailJson);
            process.exitCode = 1;
        }

        // Test: GET /api/conversations returns paginated list
        const getListRes = await fetch(`${baseUrl}/conversations?limit=2`);
        const getListJson = await getListRes.json();
        if (getListJson.conversations && Array.isArray(getListJson.conversations) && getListJson.limit === 2) {
            console.log('✅ Test: GET /api/conversations returns paginated list');
        } else {
            console.error('❌ Test: GET /api/conversations list FAILED', getListJson);
            process.exitCode = 1;
        }

        // Test: GET /api/conversations/:id returns correct conversation
        const getSingleRes = await fetch(`${baseUrl}/conversations/${c1.conversation_id}`);
        const getSingleJson = await getSingleRes.json();
        if (getSingleJson.id === c1.conversation_id) {
            console.log('✅ Test: GET /api/conversations/:id returns correct conversation');
        } else {
            console.error('❌ Test: GET single FAILED', getSingleJson);
            process.exitCode = 1;
        }

        // Test: GET /api/conversations/:id/stats returns computed stats
        const getStatsRes = await fetch(`${baseUrl}/conversations/${c1.conversation_id}/stats`);
        const getStatsJson = await getStatsRes.json();
        if (getStatsJson.turn_count === 1 && getStatsJson.mission_completed === true) {
            console.log('✅ Test: GET /api/conversations/:id/stats returns computed stats');
        } else {
            console.error('❌ Test: GET stats FAILED', getStatsJson);
            process.exitCode = 1;
        }

        // Test: POST /api/feedback inserts annotation and returns it
        const feedbackPayload = {
            conversation_id: c1.conversation_id,
            annotator_id: 'user123',
            annotation_type: 'helpfulness',
            label: 'good',
            confidence: 0.9,
            notes: 'test note'
        };
        const postFeedbackRes = await fetch(`${baseUrl}/feedback`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(feedbackPayload)
        });
        const postFeedbackJson = await postFeedbackRes.json();
        if (postFeedbackJson.label === 'good' && postFeedbackJson.annotation_type === 'helpfulness') {
            console.log('✅ Test: POST /api/feedback inserts annotation and returns it');
        } else {
            console.error('❌ Test: POST feedback FAILED', postFeedbackJson);
            process.exitCode = 1;
        }

        // Test: GET /api/feedback/:conversation_id returns annotations
        const getFeedbackRes = await fetch(`${baseUrl}/feedback/${c1.conversation_id}`);
        const getFeedbackJson = await getFeedbackRes.json();
        if (Array.isArray(getFeedbackJson) && getFeedbackJson.length > 0) {
            console.log('✅ Test: GET /api/feedback/:conversation_id returns annotations');
        } else {
            console.error('❌ Test: GET feedback FAILED', getFeedbackJson);
            process.exitCode = 1;
        }

    } catch (error) {
        console.error('Test execution error:', error);
        process.exitCode = 1;
    } finally {
        console.log('\nStopping server...');
        server.kill();
        // allow time for server handle close
        await new Promise(resolve => setTimeout(resolve, 500));
        process.exit(process.exitCode || 0);
    }
}

testApi();
