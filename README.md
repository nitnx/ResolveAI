# ResolveAI

> Autonomous AI support triage & resolution copilot — FlowZint AI Hackathon 2026

<!-- Demo Video: [INSERT_YOUTUBE_LINK_HERE] -->
<!-- Live URL: [INSERT_DEPLOYED_URL_HERE] (optional) -->

---

## Purpose

ResolveAI is an autonomous customer-support copilot that classifies intent and detects sentiment in incoming support messages, retrieves relevant company policy via an in-memory RAG retriever, and — when confidence and risk gates both pass — auto-executes refunds or replacements without human intervention.

Key capabilities:

- **Intent classification** — maps each message to one of eight categories (`refund_request`, `replacement_request`, `order_status`, `complaint`, `cancel_order`, `track_shipment`, `general_inquiry`, `escalation_request`). Messages whose confidence falls below the 0.70 floor are reassigned to `general_inquiry`.
- **Sentiment detection** — labels every message `negative`, `neutral`, or `positive`, attaches it to the conversation, and raises escalation priority for negative-sentiment cases.
- **In-memory RAG** — TF-IDF cosine similarity over seeded shipping, refund, replacement, and support policy documents; returns up to five passages above the relevance threshold and attaches them to the assistant response.
- **Confidence/risk gating** — auto-executes only when confidence ≥ `CONFIDENCE_THRESHOLD` and the refund amount ≤ `REFUND_HIGH_VALUE_LIMIT`; anything outside those bounds is escalated with an automatically generated conversation summary.
- **Transparent action log** — every orchestration step (intent, sentiment, retrieval, decision, gate check, tool call) is appended to an insert-only, chronologically ordered log that is viewable per conversation.
- **Agent dashboard** — live and resolved conversation lists, escalation queue with priority ordering, and a refund/replacement actions feed; all views refresh via configurable polling (default 4 s).

Running without an `LLM_API_KEY` activates the **MockProvider** — a fully deterministic, keyword-rule-based provider that requires zero external keys and produces consistent results for every demo run.

---

## Architecture

```
Frontend (React + Vite + TypeScript + Tailwind CSS)
    └── Chat page  (/chat)
    └── Agent Dashboard  (/dashboard)

Backend (Node.js + Express + TypeScript)
    ├── Orchestrator
    │   ├── Intent_Classifier  →  AiProvider.classifyIntent
    │   ├── Sentiment_Detector →  AiProvider.detectSentiment
    │   ├── RAG_Retriever      →  TF-IDF cosine similarity (in-memory)
    │   ├── Confidence/Risk Gate
    │   └── Business_Tools     →  processRefund / processReplacement / escalateTicket
    ├── Action_Log             →  insert-only, (timestampMs, seq) ordered
    └── REST API               →  /api/conversations  /api/dashboard  /api/seed

Database:  SQLite via better-sqlite3
           tables: customers · orders · policies · conversations · messages
                   action_logs · tickets · escalations

AI layer:  Hybrid AiProvider
           ├── LlmProvider  (activated when LLM_API_KEY is set)
           └── MockProvider (deterministic fallback — default, no external keys)

RAG:       In-memory TF-IDF index built at startup from seeded policy documents
           Minimum relevance controlled by RAG_RELEVANCE_THRESHOLD (default 0.05)
           Returns up to 5 passages, sorted by descending cosine similarity

Tests:     vitest (unit + integration) + fast-check (property-based)
           Property tests are co-located with the modules they validate
```

**Data flow for the demo scenario:**

```
Customer message
  → POST /api/conversations/:id/messages
      → classify intent   (refund_request, confidence 0.75)
      → detect sentiment  (negative)
      → log intent + sentiment
      → retrieve passages (refund policy + shipping policy)
      → log passages
      → compute confidence score → check risk gate → check confidence gate
      → log decision
      → call processRefund → mark order refunded
      → log tool_call
      → generate response with attached policy passages
  ← 200 { message, passages }
```

---

## Setup

1. **Clone the repo**

   ```bash
   git clone <YOUR_GITHUB_REPO_URL_HERE>
   cd FlowZint-AI-Hackathon-2026
   ```

2. **Install dependencies**

   Run the following from the project root (installs both workspaces):

   ```bash
   npm install
   ```

3. **Configure environment (optional)**

   Copy the example env file into the backend package:

   ```bash
   cp .env.example backend/.env
   ```

   Leave `LLM_API_KEY` empty (or omit the file entirely) to use **MockProvider** — the deterministic fallback that runs the full demo without any external API keys or accounts.

   Adjust `CONFIDENCE_THRESHOLD`, `REFUND_HIGH_VALUE_LIMIT`, `RAG_RELEVANCE_THRESHOLD`, `INTENT_CONFIDENCE_FLOOR`, or `DASHBOARD_POLL_MS` only if you want to explore non-default gate behaviour.

---

## Run

Follow these steps to reproduce the full demo scenario on seed data with no source changes:

1. **Start the backend** (API server on port 3001)

   ```bash
   npm run dev:backend
   ```

2. **Start the frontend** (Vite dev server on port 5173)

   ```bash
   npm run dev:frontend
   ```

3. **Open the chat interface**

   Navigate to `http://localhost:5173/chat` in your browser.

4. **Demo order is preselected**

   The dropdown defaults to order `ORD-1001` — a delayed, refund-eligible order that is more than 3 days past its promised delivery date.

5. **Send the demo message**

   Type the following and click **Send**:

   > My order is late and I'm angry, I want a refund

6. **Watch ResolveAI work**

   ResolveAI classifies the intent as `refund_request` with `negative` sentiment, retrieves the refund and shipping policy passages via TF-IDF RAG, verifies the refund amount is below the high-value limit, confirms confidence (≈ 0.75) exceeds the threshold, processes a mock refund, and returns a confirmation response with the retrieved policy passages attached.

7. **Open the agent dashboard**

   Navigate to `http://localhost:5173/dashboard`.

   - **Live tab** — the conversation appears with a **Negative** sentiment badge.
   - **Actions feed** — a `processRefund` entry with a `success` outcome is listed.
   - **Escalation Queue** — empty, confirming both gates passed and no escalation was triggered.

8. **Inspect the action log**

   Click the conversation row to open the Action Log modal. It shows every orchestration step in chronological order:

   | Step | Detail |
   |------|--------|
   | `intent` | `refund_request`, confidence 0.75 |
   | `sentiment` | `negative` |
   | `retrieval` | refund policy passage + shipping policy passage |
   | `decision` | path = refund, confidence = 0.75 |
   | `gate_check` | risk gate passed (amount ≤ limit); confidence gate passed (0.75 ≥ 0.5) |
   | `tool_call` | `processRefund` → success |

---

> **No external keys required.** When `LLM_API_KEY` is not set, ResolveAI automatically uses the `MockProvider` — a fully deterministic, rule-based provider. The entire demo, including intent classification, sentiment detection, RAG retrieval, gate evaluation, and refund processing, runs locally with zero external dependencies.
