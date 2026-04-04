const { v4: uuidv4 } = require('uuid');
const db = require('../src/db');

function randomChoice(arr) {
    return arr[Math.floor(Math.random() * arr.length)];
}

function generateConversation(index) {
    const agent_versions = ['v2.3.0', 'v2.3.1', 'v2.4.0'];
    const version = randomChoice(agent_versions);

    const scenarios = ['short', 'long', 'tool_fail', 'high_latency', 'normal'];
    const scenario = randomChoice(scenarios);

    const id = uuidv4();

    let turnsCount = 4;
    if (scenario === 'short') turnsCount = 2;
    if (scenario === 'long') turnsCount = 8;

    const turns = [];
    let currentLatency = 0;

    for (let i = 0; i < turnsCount; i++) {
        const isUser = i % 2 === 0;
        const role = isUser ? 'user' : 'assistant';

        let turnObj = {
            turn_id: uuidv4(),
            role: role,
            content: isUser ? `User message ${i}` : `Assistant response ${i}`,
            timestamp: new Date(Date.now() - (turnsCount - i) * 60000).toISOString()
        };

        if (role === 'assistant' && i === 1 && scenario !== 'short') {
            const toolLatency = scenario === 'high_latency' ? 5000 : Math.floor(Math.random() * 500) + 100;
            currentLatency += toolLatency;
            turnObj.tool_calls = [{
                tool_name: randomChoice(['flight_search', 'hotel_booking', 'weather_check']),
                parameters: { q: 'search query' },
                result: scenario === 'tool_fail' ? { error: 'Service Unavailable' } : { status: 'success', data: 'result' },
                latency_ms: toolLatency
            }];
        }

        turns.push(turnObj);
    }

    const mission_completed = scenario === 'normal' || scenario === 'long' || scenario === 'short';

    let feedback = {
        user_rating: Math.floor(Math.random() * 5) + 1
    };

    if (Math.random() > 0.5) {
        feedback.ops_review = {
            quality: randomChoice(['good', 'fair', 'poor']),
            notes: 'Reviewed by ops'
        };
    }

    if (Math.random() > 0.7) {
        feedback.annotations = [{
            type: 'coherence_check',
            label: 'pass',
            annotator_id: 'annotator_1'
        }];
    }

    return {
        conversation_id: id,
        agent_version: version,
        turns: turns,
        feedback: feedback,
        metadata: {
            total_latency_ms: currentLatency,
            mission_completed: mission_completed
        }
    };
}

async function seed() {
    console.log('Generating 15 conversations...');
    const convs = Array.from({ length: 15 }, (_, i) => generateConversation(i));

    let ingested = 0;
    for (const conv of convs) {
        try {
            await db.execute(
                `INSERT INTO conversations (id, agent_version, turns, feedback, metadata) 
         VALUES (?, ?, ?, ?, ?) 
         ON DUPLICATE KEY UPDATE 
         agent_version = VALUES(agent_version), 
         turns = VALUES(turns), 
         feedback = VALUES(feedback), 
         metadata = VALUES(metadata)`,
                [
                    conv.conversation_id,
                    conv.agent_version,
                    JSON.stringify(conv.turns),
                    JSON.stringify(conv.feedback),
                    JSON.stringify(conv.metadata)
                ]
            );
            ingested++;
        } catch (e) {
            console.error('Error inserting:', e);
        }
    }

    console.log(`Successfully seeded ${ingested} conversations`);
    process.exit(0);
}

seed();
