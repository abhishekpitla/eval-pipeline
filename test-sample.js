/**
 * test-sample.js
 *
 * Takes the HTML-encoded sample conversation from the requirements doc,
 * decodes it to proper JSON, and runs it through the evaluation pipeline.
 *
 * Does NOT need a running server or DB — calls evaluators directly.
 */
require('dotenv').config();

// ─── Step 1: The raw HTML-encoded sample (exactly as pasted from the requirements) ───

const htmlEncodedConversation = `{
  &quot;conversation_id&quot;: &quot;conv_abc123&quot;,
  &quot;agent_version&quot;: &quot;v2.3.1&quot;,
  &quot;turns&quot;: [
    {
      &quot;turn_id&quot;: 1,
      &quot;role&quot;: &quot;user&quot;,
      &quot;content&quot;: &quot;I need to book a flight to NYC next week&quot;,
      &quot;timestamp&quot;: &quot;2024-01-15T10:30:00Z&quot;
    },
    {
      &quot;turn_id&quot;: 2,
      &quot;role&quot;: &quot;assistant&quot;,
      &quot;content&quot;: &quot;I&#39;d be happy to help you book a flight to NYC...&quot;,
      &quot;tool_calls&quot;: [
        {
          &quot;tool_name&quot;: &quot;flight_search&quot;,
          &quot;parameters&quot;: {
            &quot;destination&quot;: &quot;NYC&quot;,
            &quot;date_range&quot;: &quot;2024-01-22/2024-01-28&quot;
          },
          &quot;result&quot;: {&quot;status&quot;: &quot;success&quot;, &quot;flights&quot;: [&quot;...&quot;]},
          &quot;latency_ms&quot;: 450
        }
      ],
      &quot;timestamp&quot;: &quot;2024-01-15T10:30:02Z&quot;
    }
  ],
  &quot;feedback&quot;: {
    &quot;user_rating&quot;: 4,
    &quot;ops_review&quot;: {
      &quot;quality&quot;: &quot;good&quot;,
      &quot;notes&quot;: &quot;Correct tool usage&quot;
    },
    &quot;annotations&quot;: [
      {
        &quot;type&quot;: &quot;tool_accuracy&quot;,
        &quot;label&quot;: &quot;correct&quot;,
        &quot;annotator_id&quot;: &quot;ann_001&quot;
      }
    ]
  },
  &quot;metadata&quot;: {
    &quot;total_latency_ms&quot;: 1200,
    &quot;mission_completed&quot;: true
  }
}`;

// ─── Step 2: Decode HTML entities → clean JSON string ───

function decodeHtmlEntities(str) {
    return str
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>');
}

const cleanJson = decodeHtmlEntities(htmlEncodedConversation);

// ─── Step 3: Parse to JavaScript object ───

let conversation;
try {
    conversation = JSON.parse(cleanJson);
} catch (e) {
    console.error('JSON parse failed:', e.message);
    process.exit(1);
}

console.log('='.repeat(60));
console.log('STEP 1: HTML DECODED → CLEAN JSON');
console.log('='.repeat(60));
console.log(JSON.stringify(conversation, null, 2));

// ─── Step 4: Adapt the schema for the evaluators ───
// The pipeline uses conv.id internally, but the input uses conversation_id
// The evaluators also expect turns to be at the top level (already is)

const adaptedConversation = {
    id: conversation.conversation_id,
    conversation_id: conversation.conversation_id,
    agent_version: conversation.agent_version,
    turns: conversation.turns,
    feedback: conversation.feedback,
    metadata: conversation.metadata
};

// ─── Step 5: Run through the current pipeline (factExtractor + llmEvaluator) ───

const factExtractor = require('./src/evaluators/factExtractor');
const llmEvaluator  = require('./src/evaluators/llmEvaluator');

async function run() {
    console.log('\n' + '='.repeat(60));
    console.log('STEP 2: RUNNING THROUGH PIPELINE');
    console.log('='.repeat(60));

    console.log('\n[1/2] Extracting facts...');
    const facts = factExtractor.extract(adaptedConversation);
    console.log('  Facts:', JSON.stringify(facts, null, 4));

    console.log('\n[2/2] Running LLM evaluator (all 4 dimensions)...');
    const { llmJudge, coherence: resCoherence, heuristic: resHeuristic, toolCall: resTool } =
        await llmEvaluator.evaluate(adaptedConversation, facts);

    console.log('  LLM Judge Score:', llmJudge.score.toFixed(3));
    console.log('  LLM Judge Details:', JSON.stringify(llmJudge.details, null, 4));
    console.log('  Heuristic Score:', resHeuristic.score.toFixed(3));
    console.log('  Tool Call Score:', resTool.isNA ? 'N/A' : resTool.score.toFixed(3));
    console.log('  Coherence Score:', resCoherence.isNA ? 'N/A' : resCoherence.score.toFixed(3));

    // ─── Step 6: Aggregate (same logic as evaluators/index.js) ───

    const hasCoherence = !resCoherence.isNA;
    const hasToolCall  = !resTool.isNA;

    let totalWeight = 0;
    let overallScore = 0;
    overallScore += llmJudge.score      * 0.30; totalWeight += 0.30;
    overallScore += resHeuristic.score  * 0.20; totalWeight += 0.20;
    if (hasCoherence) { overallScore += resCoherence.score * 0.20; totalWeight += 0.20; }
    if (hasToolCall)  { overallScore += resTool.score      * 0.30; totalWeight += 0.30; }
    if (totalWeight < 1.0) overallScore = overallScore / totalWeight;

    if (facts.total_latency_ms > 3000) overallScore = overallScore * 0.85;

    const allIssues = [
        ...(resHeuristic.issues || []),
        ...(resTool.issues || []),
        ...(llmJudge.issues || []),
        ...(resCoherence.issues || [])
    ];

    // ─── Step 7: Final evaluation output ───

    const evaluationOutput = {
        evaluation_id: 'eval_sample_test',
        conversation_id: conversation.conversation_id,
        scores: {
            overall: parseFloat(overallScore.toFixed(3)),
            response_quality: parseFloat(llmJudge.score.toFixed(3)),
            tool_accuracy: hasToolCall ? parseFloat(resTool.score.toFixed(3)) : 'N/A',
            coherence: hasCoherence ? parseFloat(resCoherence.score.toFixed(3)) : 'N/A',
            heuristic: parseFloat(resHeuristic.score.toFixed(3))
        },
        tool_evaluation: hasToolCall ? resTool.details : null,
        issues_detected: allIssues,
        improvement_suggestions: []
    };

    console.log('\n' + '='.repeat(60));
    console.log('STEP 3: FINAL EVALUATION OUTPUT');
    console.log('='.repeat(60));
    console.log(JSON.stringify(evaluationOutput, null, 2));

    console.log('\n' + '='.repeat(60));
    console.log('COMPARISON: SPEC EXPECTED vs ACTUAL');
    console.log('='.repeat(60));
    console.log('                     SPEC      ACTUAL');
    console.log(`  overall:           0.87   →  ${evaluationOutput.scores.overall}`);
    console.log(`  response_quality:  0.90   →  ${evaluationOutput.scores.response_quality}`);
    console.log(`  tool_accuracy:     0.95   →  ${evaluationOutput.scores.tool_accuracy}`);
    console.log(`  coherence:         0.85   →  ${evaluationOutput.scores.coherence}`);
}

run().catch(err => {
    console.error('Pipeline error:', err);
    process.exit(1);
});
