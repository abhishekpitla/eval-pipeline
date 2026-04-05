# AI Agent Evaluation Pipeline

A closed-loop evaluation system for AI agents. Conversations go in, a single GPT-4o call scores them across four dimensions, those scores are compared against human annotations for calibration, and the system generates actionable suggestions to improve the agent.

**Stack**: Node.js · Express · MySQL 8 · GPT-4o · React · Docker

---

## Table of Contents

1. [Architecture](#architecture)
2. [Project Structure](#project-structure)
3. [How Evaluation Works](#how-evaluation-works)
4. [Database Schema](#database-schema)
5. [Quick Start](#quick-start)
6. [Environment Variables](#environment-variables)
7. [API Documentation](#api-documentation)
8. [Design Decisions](#design-decisions)
9. [Trade-offs](#trade-offs)
10. [Scaling Strategy](#scaling-strategy)

---

## Architecture

The system follows a 5-stage pipeline:

```
Stage 1: INGEST
  Conversations (JSON) → POST /api/conversations → MySQL (conversations + annotations)

Stage 2: EVALUATE
  Conversation → factExtractor.js (objective facts) → llmEvaluator.js (single GPT-4o call)
       ↓
  4 dimension scores → MySQL (evaluations)
       ↓
  Issues detected + improvement suggestions attached

Stage 3: RECONCILE
  Evaluation scores ←→ Human annotations (confidence-weighted)
       ↓
  Per-conversation calibration (agreement / divergent)
  Annotator disagreement detection + tiebreaker resolution

Stage 4: SUGGEST
  Pattern detector mines recurring failures across evaluations
       ↓
  GPT-4o generates prompt suggestions + tool schema suggestions
       ↓
  Accept / reject / apply workflow

Stage 5: META-EVALUATE
  Precision / Recall / F1 per annotation category
  Blind spot detection (categories the evaluator consistently misses)
  Drift monitoring (evaluator scores vs human consensus over time)
```

### Data Flow

```text
[Conversation JSON]
        │
        ▼
  ┌─────────────┐     ┌──────────────────┐
  │  Ingestion   │────▶│  MySQL           │
  │  API         │     │  conversations   │
  └─────────────┘     │  annotations     │
                       └────────┬─────────┘
                                │
        ┌───────────────────────┘
        ▼
  ┌─────────────┐     ┌──────────────────┐
  │  Fact        │────▶│  LLM Evaluator   │──── single GPT-4o call
  │  Extractor   │     │  (4 dimensions)  │
  └─────────────┘     └────────┬─────────┘
                                │
                                ▼
                       ┌──────────────────┐
                       │  MySQL           │
                       │  evaluations     │
                       └────────┬─────────┘
                                │
              ┌─────────────────┼─────────────────┐
              ▼                 ▼                  ▼
     ┌──────────────┐  ┌──────────────┐  ┌──────────────┐
     │  Calibration  │  │  Pattern     │  │  Meta-Eval   │
     │  (LLM vs     │  │  Detector    │  │  (P/R/F1,    │
     │   Human)     │  │  → Suggests  │  │   Drift)     │
     └──────────────┘  └──────────────┘  └──────────────┘
              │                 │                  │
              └─────────────────┼──────────────────┘
                                ▼
                       ┌──────────────────┐
                       │  React Dashboard │
                       │  (eval-ui)       │
                       └──────────────────┘
```

---

## Project Structure

```
eval-pipeline/
├── src/
│   ├── app.js                    # Express server, route mounting
│   ├── config.js                 # Environment config (DB, port, API key)
│   ├── db.js                     # MySQL connection pool (mysql2/promise)
│   ├── worker.js                 # Async job processor (polls jobs table)
│   ├── evaluators/
│   │   ├── index.js              # Orchestrator — calls factExtractor + llmEvaluator,
│   │   │                         #   computes weighted overall score, persists to DB
│   │   ├── factExtractor.js      # Pure data extraction (no scoring) — latency,
│   │   │                         #   turn structure, tool calls, user constraints
│   │   └── llmEvaluator.js       # Single GPT-4o call scoring all 4 dimensions,
│   │                             #   prompt construction, response parsing
│   ├── meta/
│   │   ├── calibration.js        # LLM-vs-human comparison, accuracy report (P/R/F1),
│   │   │                         #   drift monitoring, correction factors
│   │   ├── disagreement.js       # Annotator disagreement detection + resolution
│   │   └── blindSpots.js         # Categories where evaluator misses human judgments
│   ├── suggestions/
│   │   ├── patternDetector.js    # Mines recurring failure patterns from evaluations
│   │   └── generator.js          # GPT-4o generates prompt + tool suggestions
│   └── routes/
│       ├── health.js             # GET /api/health
│       ├── conversations.js      # CRUD + ingestion with auto-annotation persistence
│       ├── evaluations.js        # Realtime + async evaluation, batch support
│       ├── feedback.js           # Human annotation submission
│       ├── meta.js               # Calibration, drift, accuracy, blind spots, regressions
│       ├── suggestions.js        # Suggestion CRUD + generation trigger
│       └── jobs.js               # Async job queue listing + polling
├── sql/
│   ├── schema.sql                # Full database schema (6 tables)
│   └── init.js                   # Schema initialization script
├── seed/
│   └── generate.js               # Seed data generator
├── tests/
│   ├── full-test.js              # End-to-end API + async job tests
│   ├── phase1.test.js            # Ingestion + evaluation tests
│   ├── phase2.test.js            # Calibration + meta tests
│   └── phase3.test.js            # Suggestion + regression tests
├── test-cases.js                 # 10 conversation scenarios (standalone, no DB)
├── test-sample.js                # Spec sample conversation through pipeline
├── docker-compose.yml            # MySQL + API + Worker (3 containers)
├── Dockerfile                    # API / Worker image
├── Dockerfile.ui                 # React UI image
└── package.json
```

```
eval-ui/
├── src/
│   ├── App.jsx                   # Router + sidebar navigation
│   ├── config.js                 # API base URL
│   └── pages/
│       ├── Dashboard.jsx         # Overview metrics + score chart
│       ├── Conversations.jsx     # Conversation list + details
│       ├── Evaluations.jsx       # Real-time + batch evaluation UI
│       ├── Calibration.jsx       # Calibration report + disagreement resolution
│       ├── MetaEvaluation.jsx    # P/R/F1 gauges, blind spots, drift
│       ├── Suggestions.jsx       # Accept/reject/apply improvement suggestions
│       └── FaultDetails.jsx      # Per-batch fault drill-down
├── index.html
├── vite.config.js
└── package.json
```

---

## How Evaluation Works

### Step 1: Fact Extraction (`factExtractor.js`)

Pure data extraction with zero scoring — surfaces objective facts for GPT-4o:

| Fact | What it captures |
|---|---|
| `total_latency_ms` | End-to-end latency from metadata |
| `mission_completed` | Whether the agent accomplished the user's goal |
| `turn_count` | Number of turns, structure validation (user→assistant alternation) |
| `empty_response_turns` | Turns where the assistant responded with empty content |
| `tool_calls[]` | Per-call: tool name, parameters, execution success, latency, result summary |
| `possibly_ungrounded_params` | Parameters whose values don't appear in prior user text |
| `user_constraints` | Constraints extracted from user turns ("only business class", "never …") |

### Step 2: LLM Evaluation (`llmEvaluator.js`)

A single GPT-4o call receives the conversation text + extracted facts and scores **four dimensions**:

#### Dimension 1: LLM Judge — Response Quality
| Sub-score | Weight | What it measures |
|---|---|---|
| `helpfulness` | 40% | Is the assistant genuinely useful? |
| `task_completion` | 30% | Did it accomplish the user's goal? (≤0.3 if `mission_completed=false`) |
| `factuality` | 20% | Are statements accurate and grounded? |
| `tone` | 10% | Professional and appropriate? |

#### Dimension 2: Multi-turn Coherence
| Sub-score | Weight | What it measures |
|---|---|---|
| `context_retention` | 33% | Does the agent remember earlier turns? |
| `consistency` | 33% | Any contradictions between turns? |
| `reference_resolution` | 33% | Handles "that flight", "my preference" correctly? |

Skipped (`isNA`) for conversations with fewer than 3 turns.

#### Dimension 3: Heuristic Quality
| Sub-score | Weight | What it measures |
|---|---|---|
| `latency_acceptability` | 25% | Is response latency acceptable? |
| `structural_integrity` | 25% | Valid turn structure? Empty responses? |
| `response_completeness` | 25% | Do responses fully address user messages? |
| `response_appropriateness` | 25% | Length and format appropriate for the question? |

#### Dimension 4: Tool Call Accuracy
| Sub-score | Weight | What it measures |
|---|---|---|
| `semantic_selection` | **40%** | Was each tool the right choice for user intent? |
| `parameter_accuracy` | 20% | Parameters correct and complete? |
| `hallucination_assessment` | 10% | Parameter values grounded in user text? |
| `execution_quality` | 15% | Did tools execute successfully? |
| `result_utilization` | 15% | Did the assistant use tool results in its response? |

**Hard cap**: If `semantic_selection < 0.7` (wrong tool was called), the entire tool call score is capped at 0.4. Calling the wrong tool is a fundamental failure that cannot be redeemed by good parameter accuracy on a subsequent correct call.

Skipped (`isNA`) for conversations with no tool calls.

### Step 3: Overall Score Computation (`evaluators/index.js`)

```
Overall = (LLM Judge × 0.30) + (Tool Call × 0.30) + (Coherence × 0.20) + (Heuristic × 0.20)
```

When a dimension is N/A, its weight is redistributed proportionally to the active dimensions.

**Latency penalty**: If `total_latency_ms > 3000`, the overall score is multiplied by 0.85.

### Step 4: Confidence-Based Routing

The system flags conversations for human review when:
- Overall score falls in the ambiguous zone (0.4–0.6)
- Dimension spread exceeds 0.4 (dimensions disagree with each other)
- Any critical-severity issue is detected

### Step 5: Calibration (`meta/calibration.js`)

After evaluation, if the conversation has human annotations, the system:
1. Computes a **confidence-weighted human score** — `Σ(label_score × confidence) / Σ(confidence)`
2. Compares it against the evaluation's overall score
3. Records agreement (drift ≤ 0.20) or divergence

Label mapping: `correct/good/pass → 1.0`, `partially_correct/fair → 0.5`, `incorrect/fail/poor → 0.0`

---

## Database Schema

Six tables in MySQL 8 with native JSON column support:

### `conversations`
| Column | Type | Notes |
|---|---|---|
| `id` | VARCHAR(64) PK | = `conversation_id` from input |
| `agent_version` | VARCHAR(32) | Indexed for version filtering |
| `turns` | JSON | Array of turn objects |
| `feedback` | JSON | User rating, ops review, annotations |
| `metadata` | JSON | `total_latency_ms`, `mission_completed` |
| `created_at` | TIMESTAMP | Auto-set |

### `evaluations`
| Column | Type | Notes |
|---|---|---|
| `id` | VARCHAR(64) PK | UUID |
| `conversation_id` | VARCHAR(64) FK | References conversations |
| `scores` | JSON | `overall`, `llmJudge`, `heuristic`, `coherence`, `toolCall`, `review_routing` |
| `tool_evaluation` | JSON | Tool call count + AI-scored details |
| `issues_detected` | JSON | Array of `{ type, severity, message }` |
| `improvement_suggestions` | JSON | Matched suggestions from suggestions table |
| `evaluator_version` | VARCHAR(32) | Currently `v4` |

### `annotations`
| Column | Type | Notes |
|---|---|---|
| `id` | INT PK AUTO_INCREMENT | |
| `conversation_id` | VARCHAR(64) FK | |
| `annotator_id` | VARCHAR(64) | |
| `annotation_type` | VARCHAR(64) | `tool_accuracy`, `helpfulness`, `coherence`, `overall_quality` |
| `label` | VARCHAR(64) | `correct`, `incorrect`, `good`, `poor`, etc. |
| `confidence` | FLOAT | 0–1, used for weighted averaging |
| UNIQUE | | `(conversation_id, annotator_id, annotation_type)` — prevents duplicates |

### `meta_evaluations`
Stores each LLM-vs-human comparison for calibration reporting.

### `suggestions`
| Column | Type | Notes |
|---|---|---|
| `type` | ENUM | `prompt` or `tool` |
| `suggestion` | TEXT | GPT-4o-generated improvement |
| `confidence` | FLOAT | |
| `status` | ENUM | `pending` → `accepted` / `rejected` → `applied` |

### `drift_corrections`
Stores computed correction factors per evaluator version for drift monitoring.

### `jobs`
MySQL-as-queue pattern for async processing (evaluation, batch, suggestion cycles).

---

## Quick Start

### Docker (recommended)

```sh
# Clone and navigate to the project
cd eval-pipeline

# Create .env from example
cp .env.example .env
# Edit .env — set OPENAI_API_KEY to a real key

# Launch everything (MySQL + API + Worker + UI)
docker-compose up --build
```

| Service | URL |
|---|---|
| API | `http://localhost:3000` |
| UI Dashboard | `http://localhost:5173` |
| MySQL | `localhost:3306` |

### Manual Setup (without Docker)

**Prerequisites**: Node.js 18+, MySQL 8 running on port 3306

```sh
# Backend
cd eval-pipeline
npm install
cp .env.example .env        # Edit: set DB_PASSWORD, OPENAI_API_KEY
npm run db:init              # Create database + tables
npm run db:seed              # Optional: seed sample data
npm start                    # Start API server on :3000
npm run worker               # In separate terminal — start async job processor

# Frontend
cd ../eval-ui
npm install
npm run dev                  # Start React UI on :5173
```

### Running Tests

```sh
# Standalone evaluation tests (no DB required, calls GPT-4o directly)
node test-cases.js

# End-to-end API tests (requires running MySQL)
node tests/full-test.js
```

---

## Environment Variables

| Variable | Default | Description |
|---|---|---|
| `PORT` | `3000` | API server port |
| `DB_HOST` | `127.0.0.1` | MySQL host |
| `DB_USER` | `root` | MySQL user |
| `DB_PASSWORD` | *(empty)* | MySQL password |
| `DB_NAME` | `eval_pipeline` | Database name |
| `OPENAI_API_KEY` | *(required)* | GPT-4o API key. If missing, evaluator returns default scores of 1.0 with an `llm_error` issue. |

---

## API Documentation

### Health

| Method | Endpoint | Description |
|---|---|---|
| GET | `/api/health` | Returns `{ status: "ok", db: true/false }` |

### Conversations

| Method | Endpoint | Description |
|---|---|---|
| GET | `/api/conversations` | List conversations. Query: `?limit=&offset=&agent_version=` |
| GET | `/api/conversations/:id` | Get single conversation |
| GET | `/api/conversations/:id/stats` | Turn count, tool stats, latency, rating |
| POST | `/api/conversations` | Ingest one or array of conversations. Annotations in `feedback.annotations` are auto-persisted to the annotations table. |

**Ingestion body** (single or array):
```json
{
  "conversation_id": "conv_001",
  "agent_version": "v2.6.0",
  "turns": [
    { "turn_id": 1, "role": "user", "content": "..." },
    { "turn_id": 2, "role": "assistant", "content": "...",
      "tool_calls": [{ "tool_name": "...", "parameters": {}, "result": {}, "latency_ms": 300 }] }
  ],
  "feedback": {
    "user_rating": 4,
    "annotations": [
      { "type": "tool_accuracy", "label": "correct", "annotator_id": "ann_001", "confidence": 0.95 }
    ]
  },
  "metadata": { "total_latency_ms": 1200, "mission_completed": true }
}
```

### Evaluations

| Method | Endpoint | Description |
|---|---|---|
| GET | `/api/evaluations` | List evaluations. Query: `?limit=&offset=&min_score=&max_score=` |
| GET | `/api/evaluations/:conversation_id` | Get evaluations for a conversation |
| POST | `/api/evaluations/:conversation_id` | Evaluate a conversation. Add `?realtime=true` for synchronous response; default is async (returns `job_id`). |
| POST | `/api/evaluations/batch` | Batch evaluate. Body: `{ conversation_ids: [...] }` or `{ agent_version: "v2.6.0" }`. Add `?realtime=true` for synchronous. |

**Realtime evaluation response**:
```json
{
  "id": "uuid",
  "conversation_id": "conv_001",
  "scores": {
    "overall": 0.92,
    "llmJudge": 0.90,
    "heuristic": 0.95,
    "toolCall": 0.96,
    "toolCall_na": false,
    "coherence": 1.0,
    "coherence_na": false
  },
  "review_routing": { "needs_human_review": false, "reasons": [] },
  "tool_evaluation": { "facts": { "tool_count": 2 }, "ai": { ... } },
  "issues_detected": [],
  "improvement_suggestions": [],
  "calibration": { "evalScore": 0.92, "avgHumanScore": 1.0, "agreement": true },
  "evaluator_version": "v4"
}
```

### Feedback / Annotations

| Method | Endpoint | Description |
|---|---|---|
| GET | `/api/feedback/:conversation_id` | Get all annotations for a conversation |
| POST | `/api/feedback` | Submit a human annotation |

**Annotation body**:
```json
{
  "conversation_id": "conv_001",
  "annotator_id": "reviewer_1",
  "annotation_type": "helpfulness",
  "label": "good",
  "confidence": 0.9,
  "notes": "Clear and helpful response"
}
```

### Meta & Calibration

| Method | Endpoint | Description |
|---|---|---|
| GET | `/api/meta/calibration` | Calibration report. Query: `?evaluator_type=&days=` |
| GET | `/api/meta/drift` | Drift alerts. Query: `?threshold=0.15` |
| POST | `/api/meta/calibrate/:conversation_id` | Run calibration for one conversation |
| GET | `/api/meta/accuracy` | Per-category precision/recall/F1. Query: `?days=` |
| GET | `/api/meta/blind-spots` | Evaluator blind spots. Query: `?days=&threshold=0.7` |
| GET | `/api/meta/disagreements` | Conversations where annotators disagree |
| POST | `/api/meta/disagreements/resolve` | Resolve a disagreement with a tiebreaker |
| POST | `/api/meta/corrections` | Compute drift correction factors. Query: `?threshold=0.15` |
| GET | `/api/meta/corrections` | Get latest correction factor. Query: `?evaluator_type=v4` |
| GET | `/api/meta/regressions` | Compare agent versions. Query: `?current=v2.6.0&previous=v2.3.0` |

### Suggestions

| Method | Endpoint | Description |
|---|---|---|
| GET | `/api/suggestions` | List suggestions. Query: `?type=prompt\|tool&status=pending\|accepted\|rejected\|applied&limit=` |
| POST | `/api/suggestions/generate` | Generate suggestions from recent failures. Add `?realtime=true&days=7` |
| PATCH | `/api/suggestions/:id` | Update status. Body: `{ "status": "accepted" }` |

### Jobs

| Method | Endpoint | Description |
|---|---|---|
| GET | `/api/jobs` | List jobs. Query: `?type=&status=&limit=` |
| GET | `/api/jobs/:id` | Get job status + result |

---

## Design Decisions

### Single GPT-4o Call for All 4 Dimensions

Previous iterations used 4 separate evaluator modules (heuristic.js, toolCall.js, llmJudge.js, coherence.js) each making independent LLM calls. This was consolidated into a single call with a structured prompt.

**Why**: 4 calls → 1 call reduces latency by ~75% and cost by ~60% (shared prompt context). The single call also enables cross-dimension reasoning — the model can consider how a tool failure affected response quality, which isolated calls couldn't do.

### Fact Extraction Before LLM Scoring

`factExtractor.js` pulls objective data (latency, tool results, parameter grounding, turn structure) before the LLM sees the conversation. These facts are injected into the prompt.

**Why**: LLMs hallucinate evaluations when they lack concrete data. By surfacing that "the tool returned an error" or "parameter X doesn't appear in any user message" as explicit facts, the model makes grounded judgments rather than guessing.

### Weighted Tool Call Scoring with Hard Cap

`semantic_selection` carries 40% weight (vs equal 20% in a naive average) and caps the entire tool call score at 0.4 when a wrong tool was used.

**Why**: Calling the wrong tool is a fundamental failure. Without the cap, a conversation where the agent calls the wrong tool first but retries correctly would still score ~85-90% on tool accuracy — completely masking the bug. The hard cap ensures wrong-tool failures always surface in the score.

### Raw SQL with Parameterized Queries (No ORM)

All database access uses `mysql2/promise` with parameterized queries.

**Why**: Evaluation data has deeply nested JSON structures (scores, tool details, issues). ORMs add abstraction overhead for JSON operations that MySQL 8 handles natively. Raw queries give full control over `JSON_EXTRACT`, `ON DUPLICATE KEY UPDATE`, and complex aggregation queries used in meta-evaluation.

### MySQL JSON Columns

`turns`, `feedback`, `metadata`, `scores`, `issues_detected` are all stored as native JSON columns rather than normalized tables.

**Why**: Conversations have variable structure (different numbers of turns, tool calls, annotations). JSON columns preserve the original shape, avoid expensive JOINs for deeply nested reads, and MySQL 8 supports indexed extraction via `JSON_EXTRACT`.

### MySQL-as-Queue for Async Jobs

The `jobs` table acts as a simple job queue — the worker polls for `status='pending'` rows, marks them `processing`, and writes results back.

**Why**: Avoids adding Redis/RabbitMQ as a dependency for the prototype. A single `jobs` table with atomic `UPDATE ... LIMIT 1` claims is sufficient for moderate throughput. The worker handles stale job recovery via a lock timeout.

### Confidence-Weighted Human Scores

Human annotations include a `confidence` field (0–1). Calibration computes `Σ(score × confidence) / Σ(confidence)` rather than a simple average.

**Why**: Not all annotations are equal. A reviewer who marks "incorrect" with 0.99 confidence should weigh more than one who marks "incorrect" with 0.5 confidence. This produces more accurate human baselines.

### Annotations Auto-Ingested from Conversation JSON

When a conversation is POSTed with `feedback.annotations`, those annotations are automatically persisted to the `annotations` table (with `ON DUPLICATE KEY UPDATE` to handle re-ingestion).

**Why**: Eliminates a separate annotation submission step. Whoever produces the conversation JSON can embed ground truth directly, and the system picks it up seamlessly.

---

## Trade-offs

| Choice | Benefit | Cost |
|---|---|---|
| JavaScript / no TypeScript | Fast iteration, zero compilation step | No compile-time type safety |
| Single GPT-4o call | Lower latency + cost | Prompt is complex (~1200 tokens); if the model struggles on one dimension, all four are affected |
| MySQL-as-queue | No extra infrastructure | Won't scale past ~100 concurrent jobs; no retry backoff |
| Proportional latency penalty (`× 0.85`) | Bad conversations with high latency still score low | Good conversations with slightly high latency get a small penalty they may not deserve |
| Hard cap on wrong tool score | Wrong-tool failures always visible | An agent that calls the wrong tool first but recovers perfectly still gets ≤40% on tool accuracy |
| No auth on API | Simple local/demo setup | Must add authentication before any production deployment |

---

## Scaling Strategy

### 10x Load (~1,000 evaluations/day)

- **Replace MySQL-as-queue** with Redis + Bull or RabbitMQ for the job queue. Keep MySQL for storage.
- **Read replicas** for analytics queries (dashboard, calibration reports, accuracy metrics) so the write path isn't competing with heavy reads.
- **Connection pooling** — current pool is 10 connections; increase to 50+ and add connection draining.

### 100x Load (~10,000+ evaluations/day)

- **Event streaming** — conversations flow through Kafka or Kinesis instead of direct POST. Ingestion becomes a consumer that writes to MySQL.
- **Horizontal worker scaling** — evaluator workers scale independently (already a separate container). Each pulls from the queue, calls GPT-4o, writes results. Add rate-limit-aware backoff.
- **Redis caching** for dashboard metrics, calibration reports, and suggestion lists (cache-aside with TTL).
- **Partitioned evaluations table** by `created_at` month for faster range queries on historical data.

### GPT-4o Bottleneck

At scale, GPT-4o is the single biggest cost and latency bottleneck.

- **Fine-tuned evaluator model** — use the calibration loop's human-annotated data to fine-tune a smaller model (e.g., GPT-4o-mini or an open-source model). The ground truth data is already being collected.
- **Tiered evaluation** — run the fine-tuned model on all conversations; escalate to GPT-4o only when the fine-tuned model's confidence is low or the conversation has unusual patterns.
- **Batch API** — use OpenAI's Batch API for non-realtime evaluations (50% cost reduction, results within 24h).
