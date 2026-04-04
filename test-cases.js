require('dotenv').config();

const factExtractor = require('./src/evaluators/factExtractor');
const llmEvaluator  = require('./src/evaluators/llmEvaluator');

// ─── Evaluator orchestrator (mirrors evaluators/index.js, no DB) ─────────────

async function runPipeline(conversation) {
    const facts = factExtractor.extract(conversation);
    const { llmJudge, coherence, heuristic, toolCall } = await llmEvaluator.evaluate(conversation, facts);

    const hasCoherence = !coherence.isNA;
    const hasToolCall  = !toolCall.isNA;

    let totalWeight = 0;
    let overall = 0;
    overall += llmJudge.score  * 0.30; totalWeight += 0.30;
    overall += heuristic.score * 0.20; totalWeight += 0.20;
    if (hasCoherence) { overall += coherence.score * 0.20; totalWeight += 0.20; }
    if (hasToolCall)  { overall += toolCall.score  * 0.30; totalWeight += 0.30; }
    if (totalWeight < 1.0) overall = overall / totalWeight;

    const hasUnknownTool = (toolCall.issues || []).some(i => i.type === 'unknown_tool');
    if (hasUnknownTool) overall = Math.min(overall, 0.65);
    if ((facts.total_latency_ms || 0) > 3000) overall = Math.min(overall, 0.70);

    return {
        scores: {
            overall:   +overall.toFixed(3),
            llmJudge:  +llmJudge.score.toFixed(3),
            heuristic: +heuristic.score.toFixed(3),
            coherence: hasCoherence ? +coherence.score.toFixed(3) : 'N/A',
            toolCall:  hasToolCall  ? +toolCall.score.toFixed(3)  : 'N/A'
        },
        issues_detected: [
            ...(heuristic.issues || []),
            ...(toolCall.issues  || []),
            ...(llmJudge.issues  || []),
            ...(coherence.issues || [])
        ],
        llm_details:       llmJudge.details,
        heuristic_details: heuristic.details,
        coherence_details: hasCoherence ? coherence.details : null,
        toolcall_details:  hasToolCall  ? toolCall.details  : null
    };
}

// ─── Pretty printer ───────────────────────────────────────────────────────────

function printResult(label, conversation, result) {
    const bar = '─'.repeat(60);
    console.log(`\n┌${bar}┐`);
    console.log(`│ TEST: ${label.padEnd(53)}│`);
    console.log(`└${bar}┘`);

    console.log('\n📊 SCORES');
    console.log(`  Overall:          ${colorScore(result.scores.overall)}`);
    console.log(`  LLM Judge:        ${colorScore(result.scores.llmJudge)}`);
    console.log(`  Heuristic (AI):   ${colorScore(result.scores.heuristic)}`);
    console.log(`  Coherence (AI):   ${colorScore(result.scores.coherence)}`);
    console.log(`  Tool Call (AI):   ${colorScore(result.scores.toolCall)}`);

    if (result.heuristic_details) {
        console.log('\n🧮 HEURISTIC (AI)');
        const h = result.heuristic_details;
        console.log(`  latency_acceptability:    ${h.latency_acceptability}`);
        console.log(`  structural_integrity:     ${h.structural_integrity}`);
        console.log(`  response_completeness:    ${h.response_completeness}`);
        console.log(`  response_appropriateness: ${h.response_appropriateness}`);
        if (h.reasoning) console.log(`  reasoning: "${h.reasoning}"`);
    }

    if (result.toolcall_details) {
        console.log('\n🔧 TOOL CALL (AI)');
        const t = result.toolcall_details;
        console.log(`  semantic_selection:       ${t.semantic_selection}`);
        console.log(`  parameter_accuracy:       ${t.parameter_accuracy}`);
        console.log(`  hallucination_assessment: ${t.hallucination_assessment}`);
        console.log(`  execution_quality:        ${t.execution_quality}`);
        console.log(`  result_utilization:       ${t.result_utilization}`);
        if (t.reasoning) console.log(`  reasoning: "${t.reasoning}"`);
    }

    if (result.issues_detected.length) {
        console.log('\n⚠️  ISSUES DETECTED');
        for (const issue of result.issues_detected) {
            const icon = issue.severity === 'error' ? '❌' : issue.severity === 'critical' ? '🔴' : '🟡';
            console.log(`  ${icon} [${issue.severity}] ${issue.type}: ${issue.message}`);
        }
    } else {
        console.log('\n✅ No issues detected');
    }

    if (result.llm_details?.reasoning) {
        console.log('\n🤖 LLM REASONING');
        console.log(`  "${result.llm_details.reasoning}"`);
    }

    if (result.coherence_details?.constraint_violations?.length) {
        console.log('\n🚫 CONSTRAINT VIOLATIONS');
        for (const v of result.coherence_details.constraint_violations) {
            console.log(`  - ${v}`);
        }
    }

    if (result.coherence_details?.examples_of_failures?.length) {
        console.log('\n🧠 COHERENCE FAILURES');
        for (const f of result.coherence_details.examples_of_failures) {
            console.log(`  - ${f}`);
        }
    }
}

function colorScore(score) {
    if (score === 'N/A') return `\x1b[90mN/A  \x1b[0m`;
    const s = score.toFixed(3);
    if (score >= 0.8)  return `\x1b[32m${s}\x1b[0m`; // green
    if (score >= 0.6)  return `\x1b[33m${s}\x1b[0m`; // yellow
    return                     `\x1b[31m${s}\x1b[0m`; // red
}

// ═════════════════════════════════════════════════════════════════════════════
// TEST CONVERSATIONS
// ═════════════════════════════════════════════════════════════════════════════

const tests = [

    // ── 1. HAPPY PATH ─────────────────────────────────────────────────────────
    {
        label: '1. Happy Path — Flight booked successfully',
        conversation: {
            id: 'conv_happy',
            agent_version: 'v2.4.0',
            turns: [
                { turn_id: 1, role: 'user',      content: 'I need to book a flight to NYC next week, date range Jan 22 to Jan 28.' },
                { turn_id: 2, role: 'assistant',  content: 'Sure! Let me search for available flights to NYC for Jan 22–28.',
                    tool_calls: [{
                        tool_name: 'flight_search',
                        parameters: { destination: 'NYC', date_range: '2024-01-22/2024-01-28' },
                        result: { status: 'success', flights: ['AA101', 'UA202'] },
                        latency_ms: 300
                    }]
                },
                { turn_id: 3, role: 'user',      content: 'Book AA101 please.' },
                { turn_id: 4, role: 'assistant',  content: 'Great choice! AA101 has been booked for you. You will receive a confirmation email shortly.' }
            ],
            feedback: { user_rating: 5 },
            metadata: { total_latency_ms: 600, mission_completed: true }
        }
    },

    // ── 2. HIGH LATENCY ───────────────────────────────────────────────────────
    {
        label: '2. High Latency — Slow tool response',
        conversation: {
            id: 'conv_latency',
            agent_version: 'v2.3.1',
            turns: [
                { turn_id: 1, role: 'user',     content: 'Check weather in London.' },
                { turn_id: 2, role: 'assistant', content: 'Checking weather in London now.',
                    tool_calls: [{
                        tool_name: 'weather_check',
                        parameters: { location: 'London' },
                        result: { status: 'success', temp: '15C', condition: 'cloudy' },
                        latency_ms: 4200
                    }]
                },
                { turn_id: 3, role: 'user',     content: 'Thanks.' },
                { turn_id: 4, role: 'assistant', content: 'You are welcome! The weather in London is 15°C and cloudy today.' }
            ],
            feedback: { user_rating: 3 },
            metadata: { total_latency_ms: 4500, mission_completed: true }
        }
    },

    // ── 3. TOOL FAILURE ───────────────────────────────────────────────────────
    {
        label: '3. Tool Failure — Hotel booking API down',
        conversation: {
            id: 'conv_toolfail',
            agent_version: 'v2.3.0',
            turns: [
                { turn_id: 1, role: 'user',     content: 'Book a hotel in Paris, checkin March 10, checkout March 15.' },
                { turn_id: 2, role: 'assistant', content: 'Let me book that hotel for you.',
                    tool_calls: [{
                        tool_name: 'hotel_booking',
                        parameters: { city: 'Paris', checkin: 'March 10', checkout: 'March 15' },
                        result: { error: 'Service Unavailable', status: 'failure' },
                        latency_ms: 200
                    }]
                },
                { turn_id: 3, role: 'user',     content: 'What happened?' },
                { turn_id: 4, role: 'assistant', content: 'I am sorry, the hotel booking service is currently unavailable. Please try again later.' }
            ],
            feedback: { user_rating: 2 },
            metadata: { total_latency_ms: 500, mission_completed: false }
        }
    },

    // ── 4. HALLUCINATED PARAMETERS ────────────────────────────────────────────
    {
        label: '4. Hallucinated Parameters — Agent invents dates',
        conversation: {
            id: 'conv_hallucination',
            agent_version: 'v2.3.0',
            turns: [
                { turn_id: 1, role: 'user',     content: 'I want to rent a car.' },
                { turn_id: 2, role: 'assistant', content: 'Sure, let me arrange a car rental for you.',
                    tool_calls: [{
                        tool_name: 'car_rental',
                        parameters: { pickup_location: 'JFK Airport', dates: '2024-02-14/2024-02-20' },
                        result: { status: 'success', car: 'Toyota Camry' },
                        latency_ms: 250
                    }]
                },
                { turn_id: 3, role: 'user',     content: 'Okay thanks.' },
                { turn_id: 4, role: 'assistant', content: 'Your car rental has been confirmed.' }
            ],
            feedback: { user_rating: 3 },
            metadata: { total_latency_ms: 400, mission_completed: true }
        }
    },

    // ── 5. UNKNOWN TOOL ───────────────────────────────────────────────────────
    {
        label: '5. Unknown Tool — Agent calls non-existent tool',
        conversation: {
            id: 'conv_unknowntool',
            agent_version: 'v2.4.0',
            turns: [
                { turn_id: 1, role: 'user',     content: 'Can you translate this to French: Hello world.' },
                { turn_id: 2, role: 'assistant', content: 'Let me translate that for you.',
                    tool_calls: [{
                        tool_name: 'translate_text',
                        parameters: { text: 'Hello world', target_language: 'French' },
                        result: { status: 'success', translation: 'Bonjour le monde' },
                        latency_ms: 150
                    }]
                },
                { turn_id: 3, role: 'user',     content: 'Perfect, thanks.' },
                { turn_id: 4, role: 'assistant', content: 'The translation is: Bonjour le monde.' }
            ],
            feedback: { user_rating: 4 },
            metadata: { total_latency_ms: 300, mission_completed: true }
        }
    },

    // ── 6. CONTEXT LOSS — long conversation ───────────────────────────────────
    {
        label: '6. Context Loss — Agent forgets user preference',
        conversation: {
            id: 'conv_contextloss',
            agent_version: 'v2.3.1',
            turns: [
                { turn_id: 1, role: 'user',     content: 'I only fly business class, keep that in mind.' },
                { turn_id: 2, role: 'assistant', content: 'Noted! I will only show you business class options.' },
                { turn_id: 3, role: 'user',     content: 'Great. Now search for flights to Tokyo next month.' },
                { turn_id: 4, role: 'assistant', content: 'Searching for flights to Tokyo.',
                    tool_calls: [{
                        tool_name: 'flight_search',
                        parameters: { destination: 'Tokyo', date_range: '2024-02-01/2024-02-28', cabin_class: 'economy' },
                        result: { status: 'success', flights: ['JL001 economy $800'] },
                        latency_ms: 300
                    }]
                },
                { turn_id: 5, role: 'user',     content: 'Wait, I told you business class only!' },
                { turn_id: 6, role: 'assistant', content: 'You are right, I apologize. Let me search again for business class.' }
            ],
            feedback: { user_rating: 2 },
            metadata: { total_latency_ms: 700, mission_completed: false }
        }
    },

    // ── 7. MISSING TOOL PARAMETERS ────────────────────────────────────────────
    {
        label: '7. Missing Required Params — Incomplete tool call',
        conversation: {
            id: 'conv_missingparams',
            agent_version: 'v2.3.0',
            turns: [
                { turn_id: 1, role: 'user',     content: 'Process payment of $200.' },
                { turn_id: 2, role: 'assistant', content: 'Processing your payment now.',
                    tool_calls: [{
                        tool_name: 'payment_process',
                        parameters: { amount: 200 },
                        result: { status: 'success' },
                        latency_ms: 180
                    }]
                },
                { turn_id: 3, role: 'user',     content: 'Did it go through?' },
                { turn_id: 4, role: 'assistant', content: 'Yes, the payment of $200 was processed successfully.' }
            ],
            feedback: { user_rating: 4 },
            metadata: { total_latency_ms: 350, mission_completed: true }
        }
    },

    // ── 8. SHORT CONVERSATION (1 turn) ────────────────────────────────────────
    {
        label: '8. Edge Case — Single turn (minimal valid input)',
        conversation: {
            id: 'conv_singleturn',
            agent_version: 'v2.4.0',
            turns: [
                { turn_id: 1, role: 'user',     content: 'Hi.' },
                { turn_id: 2, role: 'assistant', content: 'Hello! How can I help you today?' }
            ],
            feedback: { user_rating: 3 },
            metadata: { total_latency_ms: 100, mission_completed: false }
        }
    },

    // ── 9. EMPTY ASSISTANT RESPONSE ───────────────────────────────────────────
    {
        label: '9. Edge Case — Empty assistant response',
        conversation: {
            id: 'conv_emptyresponse',
            agent_version: 'v2.3.0',
            turns: [
                { turn_id: 1, role: 'user',     content: 'Book me a hotel in NYC.' },
                { turn_id: 2, role: 'assistant', content: '' },
                { turn_id: 3, role: 'user',     content: 'Hello?' },
                { turn_id: 4, role: 'assistant', content: 'Sorry, something went wrong on my end.' }
            ],
            feedback: { user_rating: 1 },
            metadata: { total_latency_ms: 200, mission_completed: false }
        }
    },

    // ── 10. MULTI-TOOL CHAIN — complex booking ────────────────────────────────
    {
        label: '10. Complex — Multi-tool chain (flight + hotel + payment)',
        conversation: {
            id: 'conv_multitool',
            agent_version: 'v2.4.0',
            turns: [
                { turn_id: 1, role: 'user',     content: 'Book a full trip to Paris: flight from NYC, hotel for 5 nights, pay with credit card.' },
                { turn_id: 2, role: 'assistant', content: 'I will handle everything. First, searching for flights to Paris.',
                    tool_calls: [{
                        tool_name: 'flight_search',
                        parameters: { destination: 'Paris', date_range: '2024-03-01/2024-03-06' },
                        result: { status: 'success', flights: ['AF001'] },
                        latency_ms: 280
                    }]
                },
                { turn_id: 3, role: 'user',     content: 'Looks good, go ahead and book everything.' },
                { turn_id: 4, role: 'assistant', content: 'Booking hotel in Paris now.',
                    tool_calls: [
                        {
                            tool_name: 'hotel_booking',
                            parameters: { city: 'Paris', checkin: '2024-03-01', checkout: '2024-03-06' },
                            result: { status: 'success', hotel: 'Le Marais' },
                            latency_ms: 320
                        },
                        {
                            tool_name: 'payment_process',
                            parameters: { amount: 2400, method: 'credit card' },
                            result: { status: 'success', transaction_id: 'txn_abc' },
                            latency_ms: 150
                        }
                    ]
                },
                { turn_id: 5, role: 'user',     content: 'Amazing, thank you!' },
                { turn_id: 6, role: 'assistant', content: 'Your full Paris trip is confirmed! Flight AF001, hotel Le Marais, and payment of $2400 processed. Enjoy your trip!' }
            ],
            feedback: { user_rating: 5 },
            metadata: { total_latency_ms: 800, mission_completed: true }
        }
    }
];

// ═════════════════════════════════════════════════════════════════════════════
// RUN ALL TESTS
// ═════════════════════════════════════════════════════════════════════════════

async function runAll() {
    console.log('\n' + '═'.repeat(62));
    console.log('  AI AGENT EVALUATION PIPELINE — TEST SUITE');
    console.log('  10 scenarios: happy path + edge cases');
    console.log('═'.repeat(62));

    const summary = [];

    for (const test of tests) {
        try {
            const result = await runPipeline(test.conversation);
            printResult(test.label, test.conversation, result);
            summary.push({ label: test.label, overall: result.scores.overall, issues: result.issues_detected.length });
        } catch (err) {
            console.error(`\n❌ FAILED: ${test.label}\n  ${err.message}`);
            summary.push({ label: test.label, overall: 'ERROR', issues: -1 });
        }
    }

    // ── Final summary table ──────────────────────────────────────────────────
    console.log('\n\n' + '═'.repeat(62));
    console.log('  SUMMARY');
    console.log('═'.repeat(62));
    console.log('  Test                                          Score  Issues');
    console.log('  ' + '─'.repeat(58));
    for (const s of summary) {
        const label = s.label.slice(0, 45).padEnd(45);
        const score = typeof s.overall === 'number' ? colorScore(s.overall) : '\x1b[31mERROR\x1b[0m ';
        console.log(`  ${label} ${score}  ${s.issues}`);
    }
    console.log('');
}

runAll().catch(err => {
    console.error('Fatal error:', err);
    process.exit(1);
});
