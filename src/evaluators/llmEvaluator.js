/**
 * llmEvaluator.js
 *
 * Full AI evaluation — one GPT-4o call scores all four dimensions.
 * Receives extracted facts from factExtractor.js so the model has
 * objective context (latency numbers, tool registry, missing params, etc.)
 * and makes every scoring decision itself.
 *
 * Returns:
 *   { llmJudge, coherence, heuristic, toolCall }
 *   Each: { score, details, issues }
 *   coherence and toolCall also carry isNA when not applicable.
 */

const OpenAI = require('openai');

module.exports.evaluate = async (conversation, facts) => {
    const turns = conversation.turns || [];

    // ── Defaults (used when API key is missing or call fails) ─────────────────
    const defaults = {
        llmJudge: { score: 1.0, details: { helpfulness: 1.0, factuality: 1.0, tone: 1.0, task_completion: 1.0 }, issues: [] },
        coherence: { score: null, isNA: !facts.has_enough_turns, details: { reasoning: facts.has_enough_turns ? '' : 'too few turns to evaluate' }, issues: [] },
        heuristic: { score: 1.0, details: {}, issues: [] },
        toolCall: { score: facts.has_tool_calls ? 1.0 : null, isNA: !facts.has_tool_calls, details: {}, issues: [] }
    };

    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey || apiKey === 'YOUR_API_KEY') {
        defaults.llmJudge.issues.push({ type: 'llm_error', severity: 'error', message: 'Missing OPENAI_API_KEY' });
        return defaults;
    }

    // ── Build conversation text ────────────────────────────────────────────────
    const turnsText = turns.map(t => `${t.role.toUpperCase()}: ${t.content || '[empty]'}`).join('\n');

    // ── Build facts summary for the prompt ────────────────────────────────────
    const factsSummary = `
OBJECTIVE FACTS EXTRACTED FROM CONVERSATION:
- Total latency: ${facts.total_latency_ms}ms
- Turn count: ${facts.turn_count} (structure valid: ${facts.turn_structure_valid})
- Empty assistant responses: ${facts.empty_response_turns.length > 0 ? facts.empty_response_turns.join(', ') : 'none'}
- Mission completed: ${facts.mission_completed} ← IMPORTANT: if false, task_completion MUST be scored ≤ 0.3
- User-stated constraints: ${facts.user_constraints.length > 0 ? facts.user_constraints.map(c => `"${c}"`).join(', ') : 'none'}

TOOL CALLS MADE:
${facts.has_tool_calls
            ? facts.tool_calls.map((tc, i) => `
  Tool ${i + 1}: ${tc.tool_name}
    - Parameters provided: ${JSON.stringify(tc.parameters)}
    - Params possibly ungrounded in user text: ${tc.possibly_ungrounded_params.length > 0 ? JSON.stringify(tc.possibly_ungrounded_params) : 'none'}
    - Execution success: ${tc.execution_success}
    - Tool latency: ${tc.latency_ms}ms
    - Result: ${tc.result_summary}`).join('\n')
            : '  No tool calls made.'}
`.trim();

    // ── Coherence section ─────────────────────────────────────────────────────
    const coherenceSection = !facts.has_enough_turns
        ? `PART 2 — COHERENCE: Only ${facts.turn_count} turn(s) — too few to evaluate. Return "coherence": {"skip": true, "context_retention": null, "consistency": null, "reference_resolution": null, "constraint_violations": [], "examples_of_failures": []}`
        : `PART 2 — COHERENCE:
Evaluate multi-turn coherence across:
1. context_retention (0-1): Does the agent remember and apply information from earlier turns?
2. consistency (0-1): Are there any contradictions between turns?
3. reference_resolution (0-1): Does the agent correctly handle "that flight", "my preference" etc.?
4. constraint_violations: List any user-stated constraints that were violated.

User stated these constraints: ${facts.user_constraints.length ? facts.user_constraints.map(c => `"${c}"`).join(', ') : 'none'}

Return: "coherence": {"skip": false, "context_retention": <0-1>, "consistency": <0-1>, "reference_resolution": <0-1>, "constraint_violations": ["<violation>"], "examples_of_failures": ["<failure>"]}`;

    // ── Tool section ──────────────────────────────────────────────────────────
    const toolSection = !facts.has_tool_calls
        ? `PART 4 — TOOL CALL: No tool calls were made. Return "tool_call": {"skip": true, "semantic_selection": null, "parameter_accuracy": null, "hallucination_assessment": null, "execution_quality": null, "result_utilization": null}`
        : `PART 4 — TOOL CALL:
Using the tool call facts above, evaluate:
1. semantic_selection (0-1): Was each tool semantically the right choice for the user's intent? Judge this ONLY by whether the tool name and purpose match what the user asked for. For example: user says "book a flight" and agent calls "cancel_booking" = wrong tool (score 0). User says "check weather" and agent calls "get_weather" = correct tool (score 1). Do NOT penalize simply because you don't recognize the tool name — any tool name is valid as long as it semantically matches the user's request.
2. parameter_accuracy (0-1): Were the parameters contextually correct and complete for the task?
3. hallucination_assessment (0-1): Are the parameter values grounded in what the user actually said? (1.0 = fully grounded, lower if values were invented)
4. execution_quality (0-1): Did the tools execute successfully? Did failures affect the conversation?
5. result_utilization (0-1): Did the assistant actually reference and use tool results in its response?

Return: "tool_call": {"skip": false, "semantic_selection": <0-1>, "parameter_accuracy": <0-1>, "hallucination_assessment": <0-1>, "execution_quality": <0-1>, "result_utilization": <0-1>, "reasoning": "<brief>"}`;

    // ── Full prompt ───────────────────────────────────────────────────────────
    const prompt = `You are an expert AI conversation evaluator with full context about the system.

CONVERSATION:
${turnsText}

---

${factsSummary}

---

Evaluate the conversation across FOUR dimensions and return a single JSON object.

PART 1 — RESPONSE QUALITY (LLM JUDGE):
Rate 0.0–1.0:
- helpfulness: Is the assistant genuinely useful for what the user needed?
- factuality: Are statements accurate and grounded? Hallucinating results or booking refs that don't exist = 0.0.
- tone: Is the tone appropriate and professional?
- task_completion: Did the assistant fully accomplish what the user asked? RULE: if mission_completed=false (see facts above), this MUST be ≤ 0.3. If the agent hallucinated a result or gave up, score 0.0–0.2.

Return: "llm_judge": {"helpfulness": <0-1>, "factuality": <0-1>, "tone": <0-1>, "task_completion": <0-1>, "reasoning": "<concise>"}

---

${coherenceSection}

---

PART 3 — HEURISTIC QUALITY:
Using the objective facts provided, evaluate:
1. latency_acceptability (0-1): Is the response latency acceptable? (>3000ms = very low, >1000ms = moderate penalty, <500ms = full marks)
2. structural_integrity (0-1): Is the turn structure valid? Are there empty responses?
3. response_completeness (0-1): Do assistant responses fully address each user message? RULE: if mission_completed=false, this must be ≤ 0.4 unless the failure was outside the agent's control.
4. response_appropriateness (0-1): Is the length and format of each response appropriate for the question?

Return: "heuristic": {"latency_acceptability": <0-1>, "structural_integrity": <0-1>, "response_completeness": <0-1>, "response_appropriateness": <0-1>, "reasoning": "<brief>"}

---

${toolSection}

---

REQUIRED OUTPUT — single JSON object, no extra keys:
{
  "llm_judge": {
    "helpfulness": <number>, "factuality": <number>, "tone": <number>,
    "task_completion": <number>, "reasoning": "<string>"
  },
  "coherence": {
    "skip": <boolean>, "context_retention": <number|null>, "consistency": <number|null>,
    "reference_resolution": <number|null>, "constraint_violations": [<strings>], "examples_of_failures": [<strings>]
  },
  "heuristic": {
    "latency_acceptability": <number>, "structural_integrity": <number>,
    "response_completeness": <number>, "response_appropriateness": <number>, "reasoning": "<string>"
  },
  "tool_call": {
    "skip": <boolean>, "semantic_selection": <number|null>, "parameter_accuracy": <number|null>,
    "hallucination_assessment": <number|null>, "execution_quality": <number|null>,
    "result_utilization": <number|null>, "reasoning": "<string>"
  }
}`;

    try {
        console.log(`\n[LLMEvaluator] Initiating OpenAI evaluation for a ${turnsText.length} character sequence.`);

        const client = new OpenAI({ apiKey });
        const res = await client.chat.completions.create({
            model: 'gpt-4o',
            max_tokens: 1200,
            response_format: { type: 'json_object' },
            messages: [{ role: 'user', content: prompt }]
        });

        console.log(`[LLMEvaluator] ✅ OpenAI response received.`);
        if (res.usage) {
            console.log(`[LLMEvaluator] 📊 Token Usage -> Prompt: ${res.usage.prompt_tokens} | Completion: ${res.usage.completion_tokens} | Total: ${res.usage.total_tokens}`);
        }

        const parsed = JSON.parse(res.choices[0]?.message?.content || '{}');
        const result = {
            llmJudge: { score: 1.0, details: {}, issues: [] },
            coherence: { score: null, isNA: !facts.has_enough_turns, details: {}, issues: [] },
            heuristic: { score: 1.0, details: {}, issues: [] },
            toolCall: { score: null, isNA: !facts.has_tool_calls, details: {}, issues: [] }
        };

        // ── PART 1: LLM Judge ─────────────────────────────────────────────────
        const lj = parsed.llm_judge || {};
        result.llmJudge.details = {
            helpfulness: lj.helpfulness ?? 1.0,
            factuality: lj.factuality ?? 1.0,
            tone: lj.tone ?? 1.0,
            task_completion: lj.task_completion ?? 1.0,
            reasoning: lj.reasoning || ''
        };
        result.llmJudge.score =
            (result.llmJudge.details.helpfulness * 0.4) +
            (result.llmJudge.details.task_completion * 0.3) +
            (result.llmJudge.details.factuality * 0.2) +
            (result.llmJudge.details.tone * 0.1);

        // ── PART 2: Coherence ─────────────────────────────────────────────────
        const coh = parsed.coherence || {};
        if (!facts.has_enough_turns || coh.skip) {
            result.coherence.isNA = true;
            result.coherence.score = null;
            result.coherence.details.reasoning = 'too few turns to evaluate';
        } else {
            result.coherence.isNA = false;
            result.coherence.details = {
                context_retention: coh.context_retention ?? 1.0,
                consistency: coh.consistency ?? 1.0,
                reference_resolution: coh.reference_resolution ?? 1.0,
                constraint_violations: coh.constraint_violations || [],
                examples_of_failures: coh.examples_of_failures || []
            };
            result.coherence.score = (
                result.coherence.details.context_retention +
                result.coherence.details.consistency +
                result.coherence.details.reference_resolution
            ) / 3;

            // Surface constraint violations as issues
            for (const v of result.coherence.details.constraint_violations) {
                result.coherence.issues.push({ type: 'constraint_violation', severity: 'warning', message: v });
            }
        }

        // ── PART 3: Heuristic ─────────────────────────────────────────────────
        const hr = parsed.heuristic || {};
        result.heuristic.details = {
            latency_acceptability: hr.latency_acceptability ?? 1.0,
            structural_integrity: hr.structural_integrity ?? 1.0,
            response_completeness: hr.response_completeness ?? 1.0,
            response_appropriateness: hr.response_appropriateness ?? 1.0,
            reasoning: hr.reasoning || ''
        };
        result.heuristic.score = (
            result.heuristic.details.latency_acceptability +
            result.heuristic.details.structural_integrity +
            result.heuristic.details.response_completeness +
            result.heuristic.details.response_appropriateness
        ) / 4;

        // Surface heuristic issues
        if (hr.latency_acceptability < 0.5) {
            result.heuristic.issues.push({ type: 'latency', severity: facts.total_latency_ms > 3000 ? 'critical' : 'warning', message: `Latency ${facts.total_latency_ms}ms rated ${hr.latency_acceptability} by evaluator` });
        }
        if (facts.empty_response_turns.length > 0) {
            result.heuristic.issues.push({ type: 'empty_response', severity: 'error', message: `Empty assistant response on turn(s): ${facts.empty_response_turns.join(', ')}` });
        }

        // ── PART 4: Tool Call ─────────────────────────────────────────────────
        const tc = parsed.tool_call || {};
        if (!facts.has_tool_calls || tc.skip) {
            result.toolCall.isNA = true;
            result.toolCall.score = null;
        } else {
            result.toolCall.isNA = false;
            result.toolCall.details = {
                semantic_selection: tc.semantic_selection ?? 1.0,
                parameter_accuracy: tc.parameter_accuracy ?? 1.0,
                hallucination_assessment: tc.hallucination_assessment ?? 1.0,
                execution_quality: tc.execution_quality ?? 1.0,
                result_utilization: tc.result_utilization ?? 1.0,
                reasoning: tc.reasoning || ''
            };
            result.toolCall.score = (
                result.toolCall.details.semantic_selection +
                result.toolCall.details.parameter_accuracy +
                result.toolCall.details.hallucination_assessment +
                result.toolCall.details.execution_quality +
                result.toolCall.details.result_utilization
            ) / 5;

            // Surface tool issues from AI judgment
            if ((tc.semantic_selection ?? 1) < 0.7) {
                result.toolCall.issues.push({ type: 'wrong_tool', severity: 'error', message: `AI rated semantic tool selection at ${tc.semantic_selection}` });
            }
            if ((tc.hallucination_assessment ?? 1) < 0.7) {
                result.toolCall.issues.push({ type: 'hallucinated_parameter', severity: 'warning', message: `AI detected ungrounded parameters (score: ${tc.hallucination_assessment})` });
            }
            if ((tc.execution_quality ?? 1) < 0.6) {
                result.toolCall.issues.push({ type: 'execution_failure', severity: 'error', message: `Tool execution quality rated ${tc.execution_quality}` });
            }


        }

        return result;

    } catch (error) {
        defaults.llmJudge.issues.push({ type: 'llm_error', severity: 'error', message: error.message });
        return defaults;
    }
};
