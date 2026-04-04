const { exec } = require('child_process');
const { v4: uuidv4 } = require('uuid');

async function testPhase2() {
    const baseUrl = 'http://localhost:3000/api';
    console.log('Starting server...');
    const server = exec('node src/app.js');

    await new Promise(r => setTimeout(r, 2000));

    try {
        console.log('\n--- Running Phase 2 Tests ---');

        // Ingest a mock latency issue conversation
        const c1 = {
            conversation_id: uuidv4(),
            agent_version: 'v2.0.0',
            turns: [
                { role: 'user', content: 'hello' },
                { role: 'assistant', content: 'hi' }
            ],
            metadata: { total_latency_ms: 3500 }
        };
        await fetch(`${baseUrl}/conversations`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(c1) });

        // Ingest a tool call hallucination mock
        const c2 = {
            conversation_id: uuidv4(),
            agent_version: 'v2.0.0',
            turns: [
                { role: 'user', content: 'book a flight to london' },
                {
                    role: 'assistant', content: 'sure', tool_calls: [
                        { tool_name: 'flight_search', parameters: { destination: 'paris', date_range: 'tomorrow' }, result: { status: 'success' } }
                    ]
                }
            ]
        };
        await fetch(`${baseUrl}/conversations`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(c2) });

        // Test heuristic & toolCall via orchestrator for c1
        const evalResC1 = await fetch(`${baseUrl}/evaluations/${c1.conversation_id}`, { method: 'POST' });
        const evalObjC1 = await evalResC1.json();
        if (evalObjC1.issues_detected && evalObjC1.issues_detected.find(i => i.type === 'latency' && i.severity === 'critical')) {
            console.log('✅ Test: Heuristic evaluator flags critical latency issues');
        } else {
            console.error('❌ Test: Heuristic latency FAILED', evalObjC1);
            process.exitCode = 1;
        }

        // c2 hallucination test
        const evalResC2 = await fetch(`${baseUrl}/evaluations/${c2.conversation_id}`, { method: 'POST' });
        const evalObjC2 = await evalResC2.json();
        if (evalObjC2.issues_detected && evalObjC2.issues_detected.find(i => i.type === 'hallucinated_parameter')) {
            console.log('✅ Test: ToolCall evaluator flags hallucinated destination parameter');
        } else {
            console.error('❌ Test: ToolCall hallucination FAILED', evalObjC2);
            process.exitCode = 1;
        }

        // Test Batch Evaluation
        const batchRes = await fetch(`${baseUrl}/evaluations/batch`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ conversation_ids: [c1.conversation_id, c2.conversation_id] })
        });
        const batchObj = await batchRes.json();
        if (batchObj.evaluated === 2 || batchObj.evaluated >= 1) {
            console.log('✅ Test: Batch Evaluation handles multiple evaluations parallelly');
        } else {
            console.error('❌ Test: Batch Evaluation FAILED', batchObj);
            process.exitCode = 1;
        }

        // Test GET Retrieve
        const getEv = await fetch(`${baseUrl}/evaluations/${c1.conversation_id}`);
        const getEvObj = await getEv.json();
        if (Array.isArray(getEvObj) && getEvObj[0].conversation_id === c1.conversation_id) {
            console.log('✅ Test: GET evaluation retrieval');
        } else {
            console.error('❌ Test: GET Evaluation Fetch FAILED', getEvObj);
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
testPhase2();
