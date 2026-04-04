const OpenAI = require('openai');
const db = require('../db');
const patternDetector = require('./patternDetector');

async function callOpenAI(prompt) {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey || apiKey === 'YOUR_API_KEY') {
        throw new Error('OPENAI_API_KEY missing');
    }

    const client = new OpenAI({ apiKey });

    console.log(`\n[Suggestions Generator] 🤖 Calling OpenAI to analyze failure patterns (Prompt length: ${prompt.length})`);
    const res = await client.chat.completions.create({
        model: 'gpt-4o',
        max_tokens: 1000,
        response_format: { type: 'json_object' },
        messages: [
            { role: 'system', content: 'You are an AI evaluation assistant. Always respond with a JSON object containing a "results" array.' },
            { role: 'user', content: prompt }
        ]
    });

    console.log(`[Suggestions Generator] ✅ OpenAI response received.`);
    if (res.usage) {
        console.log(`[Suggestions Generator] 📊 Token Usage -> Prompt: ${res.usage.prompt_tokens} | Completion: ${res.usage.completion_tokens} | Total: ${res.usage.total_tokens}`);
    }

    const parsed = JSON.parse(res.choices[0]?.message?.content || '{}');
    return parsed.results || [];
}

// Deduplication: skip if a pending suggestion with same type+target already exists
async function isDuplicate(type, target) {
    const existing = await db.queryOne(
        `SELECT id FROM suggestions WHERE type = ? AND target = ? AND status = 'pending' LIMIT 1`,
        [type, target]
    );
    return !!existing;
}

module.exports.generatePromptSuggestions = async (patterns) => {
    try {
        const top = patterns.slice(0, 3);
        if (!top.length) return [];

        const prompt = `Here are failure patterns detected in an AI agent: ${JSON.stringify(top)}.
For each pattern, suggest a specific prompt modification. Return a JSON object with a "results" array in exactly this format:
{"results": [{"pattern": "issue_type", "suggestion": "...", "rationale": "...", "expected_impact": "high/medium/low", "confidence": 0.9}]}`;

        const generated = await callOpenAI(prompt);
        const inserted = [];

        for (const g of generated) {
            const target = g.pattern || 'general';

            // Skip if a pending suggestion for this target already exists
            if (await isDuplicate('prompt', target)) {
                console.log(`[generator] Skipping duplicate prompt suggestion for target: ${target}`);
                continue;
            }

            await db.execute(
                `INSERT INTO suggestions (type, target, pattern, suggestion, rationale, confidence, supporting_conversation_ids)
                 VALUES (?, ?, ?, ?, ?, ?, ?)`,
                ['prompt', target, JSON.stringify(g), g.suggestion || '', g.rationale || '', g.confidence || 0.5, JSON.stringify([])]
            );
            inserted.push(g);
        }
        return inserted;
    } catch (error) {
        console.error('generatePromptSuggestions error:', error);
        return [];
    }
};

module.exports.generateToolSuggestions = async (toolPatterns) => {
    try {
        if (!toolPatterns.length) return [];

        const prompt = `Here are tool call failure patterns: ${JSON.stringify(toolPatterns)}.
For each tool, suggest schema/description improvements or missing validations. Return a JSON object with a "results" array in this format:
{"results": [{"tool_name": "name", "issue": "...", "suggestion": "...", "rationale": "...", "confidence": 0.9}]}`;

        const generated = await callOpenAI(prompt);
        const inserted = [];

        for (const g of generated) {
            const target = g.tool_name || 'unknown';

            if (await isDuplicate('tool', target)) {
                console.log(`[generator] Skipping duplicate tool suggestion for target: ${target}`);
                continue;
            }

            await db.execute(
                `INSERT INTO suggestions (type, target, pattern, suggestion, rationale, confidence, supporting_conversation_ids)
                 VALUES (?, ?, ?, ?, ?, ?, ?)`,
                ['tool', target, JSON.stringify(g), g.suggestion || '', g.rationale || '', g.confidence || 0.5, JSON.stringify([])]
            );
            inserted.push(g);
        }
        return inserted;
    } catch (error) {
        console.error('generateToolSuggestions error:', error);
        return [];
    }
};

module.exports.runSuggestionCycle = async (days = 7) => {
    const p = await patternDetector.detectFailurePatterns(days);
    const prompts = await module.exports.generatePromptSuggestions(p);

    const tp = await patternDetector.detectToolPatterns(days);
    const tools = await module.exports.generateToolSuggestions(tp);

    return { prompt_suggestions: prompts, tool_suggestions: tools };
};
