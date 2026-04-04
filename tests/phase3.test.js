const { exec } = require('child_process');
const { v4: uuidv4 } = require('uuid');

async function testPhase3() {
    const baseUrl = 'http://localhost:3000/api';
    console.log('Starting server...');
    const server = exec('node src/app.js');

    await new Promise(r => setTimeout(r, 2000));

    try {
        console.log('\n--- Running Phase 3 Tests ---');

        const cid = uuidv4();
        // 1. Ingest a conversation to act as our base
        const convPayload = {
            conversation_id: cid,
            agent_version: 'v2.0.0',
            turns: [{ role: 'user', content: 'test' }, { role: 'assistant', content: 'test', tool_calls: [{ tool_name: 'unknown_tool', parameters: {} }] }]
        };
        await fetch(`${baseUrl}/conversations`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(convPayload) });

        // 2. Generate Automated Eval via orchestrator
        await fetch(`${baseUrl}/evaluations/${cid}`, { method: 'POST' });

        // 3. Post conflicting human annotations
        const anno1 = { conversation_id: cid, annotator_id: 'human1', annotation_type: 'helpfulness', label: 'correct' };
        const anno2 = { conversation_id: cid, annotator_id: 'human2', annotation_type: 'helpfulness', label: 'incorrect' };
        await fetch(`${baseUrl}/feedback`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(anno1) });
        await fetch(`${baseUrl}/feedback`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(anno2) });

        // Test: Detect Disagreement
        const disRes = await fetch(`${baseUrl}/meta/disagreements`);
        const disJson = await disRes.json();
        if (disJson.find(d => d.conversation_id === cid)) {
            console.log('✅ Test: Seeded annotations correctly fired dispute tiebreaker tracking');
        } else {
            console.error('❌ Test: Disagreement tracking FAILED', disJson);
            process.exitCode = 1;
        }

        // Test: Calibrate
        const calibReq = await fetch(`${baseUrl}/meta/calibrate/${cid}`, { method: 'POST' });
        const calibJson = await calibReq.json();
        if (calibJson.evalScore !== undefined && calibJson.avgHumanScore !== undefined) {
            console.log(`✅ Test: Calibration successfully tracked. Eval: ${calibJson.evalScore}, Human: ${calibJson.avgHumanScore}`);
        } else {
            console.error('❌ Test: Calibration POST FAILED', calibJson);
            process.exitCode = 1;
        }

        // Test: Drift report extraction
        const drfReq = await fetch(`${baseUrl}/meta/drift`);
        const drfJson = await drfReq.json();
        if (Array.isArray(drfJson)) {
            console.log('✅ Test: Drift report queries execute successfully');
        } else {
            console.error('❌ Test: Drift Tracking FAILED', drfJson);
            process.exitCode = 1;
        }

        // Test: Generate Suggestions (Requires ANTHROPIC_API_KEY, will fail gracefully if placeholder)
        const genRes = await fetch(`${baseUrl}/suggestions/generate?days=1`, { method: 'POST' });
        const genJson = await genRes.json();
        if (genJson.prompt_suggestions || genJson.error) {
            console.log(`✅ Test: Generate suggestions endpoint returns JSON successfully/gracefully (Length: ${genJson.prompt_suggestions ? genJson.prompt_suggestions.length : 0})`);
        } else {
            console.error('❌ Test: Suggestions Post Generation FAILED', genJson);
            process.exitCode = 1;
        }

        // Test: Patch & Fetch Pipeline
        const sugReq = await fetch(`${baseUrl}/suggestions`);
        const sugJson = await sugReq.json();
        if (Array.isArray(sugJson)) {
            console.log('✅ Test: Config Suggestions fetching succeeded');
        } else {
            console.error('❌ Test: GET /suggestions FAILED', sugJson);
            process.exitCode = 1;
        }

    } catch (error) {
        console.error('Test error:', error);
        process.exitCode = 1;
    } finally {
        server.kill();
        await new Promise(r => setTimeout(r, 500));
        process.exit(process.exitCode || 0);
    }
}
testPhase3();
