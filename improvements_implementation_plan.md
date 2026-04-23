# Pensieve Multi-Phase Refactoring Plan

A systematic refactoring of the Pensieve Obsidian plugin to address multi-agent scaling, context amnesia, API inefficiencies, and brittle intent routing.

## User Review Required

> [!NOTE]
> **Decision: Native Tool Calling (Phase 1.1) — HYBRID APPROACH.**
> Intermediate steps use native tool calling (`stream: false`) for reliability. While waiting, fire `onTrace({ type: "observation", content: "⚙️ Agent is reasoning..." })` to mask latency. For the final answer, switch back to `stream: true` (without `tools`) for the typewriter effect.

> [!NOTE]
> **Decision: Agent Consolidation (Phase 2.1) — FULL MERGE APPROVED.**
> 11 → 4 agents. The intelligence burden shifts from the Intent Classifier (picking 1 of 11 agents) to Tool Selection within each agent (picking 1 of ~10 tools). Small models are much better at the latter.

> [!NOTE]
> **Decision: Human-in-the-Loop (Phase 4.1) — YIELD AND RESUME, NO HANGING PROMISES.**
> When `ask_user` is called, the ReAct loop terminates gracefully and prints the question as the assistant response. The user's reply appends to `chatHistory` as a normal message. The Orchestrator re-evaluates, sees ongoing context, routes back to the same agent. State is preserved in message history, not in a hanging Promise.

---

## Phase 1: Core API & ReAct Loop Stability

### 1.1 — Native Ollama Tool Calling

**Problem:** XML `<tool_call>` tag parsing via regex is fragile. LLMs inconsistently format XML, causing `MalformedToolCallError` and wasted iterations.

**Design Decision:** Hybrid approach (approved):
- **Intermediate steps:** Send `tools` + `stream: false`. The model returns `message.tool_calls` as structured JSON. While waiting, fire a "reasoning" trace step to mask latency.
- **Final answer step:** After max iterations or when forced, call `ollama.chat()` with `stream: true` and *no* `tools` parameter — gives the user the typewriter streaming effect.
- `<final_answer>` XML tag is retained for extracting the answer from the streamed response.
- `<thought>` tags remain optional — the model can include them in the content field alongside tool calls.

**Files changed:**

---

#### [MODIFY] [ollama.ts](file:///Users/taha/PyCharmProjects/Pensieve/src/ollama.ts)

1. Add `OllamaToolDef` interface matching Ollama's `tools` schema:
   ```ts
   interface OllamaToolDef {
     type: "function";
     function: {
       name: string;
       description: string;
       parameters: { type: "object"; required: string[]; properties: Record<string, { type: string; description: string }> };
     };
   }
   ```
2. Extend `OllamaMessage` to support `role: "tool"` and `tool_calls`:
   ```ts
   interface OllamaMessage {
     role: "system" | "user" | "assistant" | "tool";
     content: string;
     tool_calls?: { function: { name: string; arguments: Record<string, unknown> } }[];
   }
   ```
3. Add a **non-streaming** `chatWithTools()` method that sends `tools` and `stream: false`, returning the parsed response including `tool_calls`.
4. Keep existing `chat()` streaming method for the direct chat path and final answer generation.

---

#### [MODIFY] [registry.ts](file:///Users/taha/PyCharmProjects/Pensieve/src/tools/registry.ts)

1. Add `generateOllamaToolDefs(toolNames?: string[])` method that converts `Tool[]` into the Ollama-native `tools` JSON schema array. If `toolNames` is provided, only include those tools (Phase 2.2 prerequisite).
2. Keep `parseThought()` and `parseFinalAnswer()` — still needed.
3. Keep `parseToolCall()` as a fallback for non-tool-calling models.
4. Remove `generateSchemaPrompt()` usage from agent system prompts (the schema is now in the API payload, not the prompt text).

---

#### [MODIFY] [react.ts](file:///Users/taha/PyCharmProjects/Pensieve/src/agents/react.ts)

1. Replace the current `ollama.chat()` call with `ollama.chatWithTools()` + the tool defs from registry.
2. Process the response:
   - If `response.message.tool_calls` exists → execute the tool, push a `role: "tool"` message with the result, continue loop.
   - If response content contains `<final_answer>` → extract and return.
   - If no tool call and no final answer → treat as raw response (fallback).
3. Remove the `REACT_FORMAT` XML instruction block for tool calls (keep thought/final_answer instructions in a simpler form).
4. Remove the `MalformedToolCallError` recovery path (native tool calling has structured JSON output, no more malformed JSON).

---

### 1.2 — Fix Observation Truncation Bug

**Problem:** Line 157-158 of `react.ts` truncates observations to 500 chars, destroying the Researcher's ability to synthesize web pages.

**Design:**
- **Tag observations as "large content"** based on the source tool name (`read_webpage`, `read_note`, `query_wikipedia`, `get_knowledge_graph`).
- For large-content observations: retain the **most recent** one in full; only truncate when it ages out to the second-most-recent position.
- For all other observations: truncate to 500 chars as before.

#### [MODIFY] [react.ts](file:///Users/taha/PyCharmProjects/Pensieve/src/agents/react.ts)

1. Track the tool name associated with each observation message.
2. In the compactor block (lines 142-161), check if the old observation came from a large-content tool. If so, summarize it via a one-shot LLM call rather than hard-truncating.
3. Alternative (simpler): increase the truncation limit to 3000 chars for `read_webpage`/`query_wikipedia` observations, and keep 500 for others.

---

### 1.3 — Fix JSON Escaping in Ontologist

**Problem:** `ontologist.ts` instructs the LLM to pass triplets as a stringified JSON string inside a JSON object, causing double-escaping: `"triplets": "[{\"subject\"...}]"`.

#### [MODIFY] [graph_tools.ts](file:///Users/taha/PyCharmProjects/Pensieve/src/tools/graph_tools.ts)

1. Change the `triplets` parameter type from `"string"` to `"string"` but update the `execute()` to handle both raw arrays and stringified arrays gracefully.
2. With native tool calling (Phase 1.1), the model produces a proper JSON object for arguments. The `triplets` value will be a native array, not a string. Add type-checking:
   ```ts
   const raw = args["triplets"];
   const array = Array.isArray(raw) ? raw : JSON.parse(cleanJsonString(String(raw)));
   ```

#### [MODIFY] [ontologist.ts](file:///Users/taha/PyCharmProjects/Pensieve/src/agents/ontologist.ts)

1. Simplify the system prompt — remove the complex 1-shot example with quadruple-escaped JSON.
2. With native tool calling, the model will produce `{ "triplets": [{ "subject": "...", ... }] }` natively. The prompt only needs to describe the semantic extraction task, not the JSON formatting.

---

### 1.4 — Robust Intent Classification

**Problem:** `orchestrator.ts` line 87: `.replace(/[^a-z_]/g, "")` destroys intent if the LLM adds filler text like "The category is write_task."

#### [MODIFY] [orchestrator.ts](file:///Users/taha/PyCharmProjects/Pensieve/src/agents/orchestrator.ts)

1. Replace the naive regex strip with a scan for known intent strings:
   ```ts
   const validIntents: IntentType[] = [...];
   const raw = response.trim().toLowerCase();
   // Try exact match first
   for (const intent of validIntents) {
     if (raw === intent) return intent;
   }
   // Scan for embedded match
   for (const intent of validIntents) {
     if (raw.includes(intent)) return intent;
   }
   // Fallback to keyword heuristics
   ```
2. Alternatively, use Ollama's JSON mode (`"format": "json"`) to force structured output:
   ```json
   { "intent": "write_task" }
   ```

---

## Phase 2: Agent Consolidation & Tool Scoping

### 2.1 — Condense 11 Agents → 4

**Current 11 agents and their proposed mapping:**

| Old Agent | Old IntentType | New Agent | New IntentType |
|-----------|---------------|-----------|----------------|
| WriterAgent | `write_task` | **Editor** | `editor` |
| PlannerAgent | `plan_task` | **Editor** | `editor` |
| ReviewerAgent | `review_task` | **Editor** | `editor` |
| CriticAgent | `factcheck_task` | **Editor** | `editor` |
| FactCheckerAgent | `factcheck_task` | **Editor** | `editor` |
| OrganizerAgent | `organize_task` | **Librarian** | `librarian` |
| OntologistAgent | `synthesize_task` | **Librarian** | `librarian` |
| ArchivistAgent | `archive_task` | **Librarian** | `librarian` |
| GovernorAgent | `govern_task` | **Librarian** | `librarian` |
| VaultGardenerAgent | `garden_task` | **Librarian** | `librarian` |
| ExplorerAgent | `explore_task` | **Researcher** | `researcher` |
| ResearcherAgent | `ingest_url` | **Researcher** | `researcher` |

**New `IntentType` enum:**
```ts
type IntentType = "direct_chat" | "editor" | "librarian" | "researcher";
```

**Files changed:**

#### [NEW] [editor.ts](file:///Users/taha/PyCharmProjects/Pensieve/src/agents/editor.ts)
- Comprehensive system prompt combining Writer, Planner, Reviewer, Critic, and FactChecker capabilities.
- Defines `allowedTools: string[]` for tool scoping (Phase 2.2).

#### [NEW] [librarian.ts](file:///Users/taha/PyCharmProjects/Pensieve/src/agents/librarian.ts)
- Comprehensive system prompt combining Organizer, Ontologist, Archivist, Governor, and Gardener capabilities.
- Defines `allowedTools: string[]`.

#### [MODIFY] [researcher.ts](file:///Users/taha/PyCharmProjects/Pensieve/src/agents/researcher.ts)
- Absorb Explorer's structural-holes and information-gain analysis into the Researcher's capabilities.
- Defines `allowedTools: string[]`.

#### [MODIFY] [orchestrator.ts](file:///Users/taha/PyCharmProjects/Pensieve/src/agents/orchestrator.ts)
- Update `CLASSIFY_PROMPT` to use 4 categories instead of 12.
- Update the agent map.
- Simplify keyword fallbacks.

#### [MODIFY] [types.ts](file:///Users/taha/PyCharmProjects/Pensieve/src/agents/types.ts)
- Update `IntentType` union type.
- Add `allowedTools?: string[]` to `ReActAgent`.

#### [DELETE] Old agent files: `writer.ts`, `planner.ts`, `reviewer.ts`, `critic.ts`, `factchecker.ts`, `organizer.ts`, `ontologist.ts`, `archivist.ts`, `explorer.ts`, `governor.ts`, `synthesizer.ts`

---

### 2.2 — Dynamic Tool Scoping

**Problem:** Every agent gets every tool in its prompt — 27+ tools injected into every system prompt, consuming ~2000 tokens.

#### [MODIFY] [types.ts](file:///Users/taha/PyCharmProjects/Pensieve/src/agents/types.ts)
- Add `allowedTools: string[]` to `ReActAgent` abstract class.

#### [MODIFY] [react.ts](file:///Users/taha/PyCharmProjects/Pensieve/src/agents/react.ts)
- When building the Ollama request, generate tool defs only for `agent.allowedTools` instead of all tools.

#### [MODIFY] [registry.ts](file:///Users/taha/PyCharmProjects/Pensieve/src/tools/registry.ts)
- `generateOllamaToolDefs(toolNames?: string[])` — filter by allowed names.

**Tool scoping plan:**

| Agent | Allowed Tools |
|-------|--------------|
| **Editor** | `read_note`, `write_note`, `append_to_note`, `create_note`, `create_daily_note`, `create_weekly_note`, `search_vault`, `open_note`, `update_frontmatter`, `delegate_task` |
| **Librarian** | `read_note`, `list_notes`, `search_vault`, `move_rename_note`, `archive_note`, `update_frontmatter`, `lint_yaml_frontmatter`, `reparent_orphan_nodes`, `extract_knowledge_triplets`, `graph_traversal_search`, `get_knowledge_graph`, `compress_cluster`, `get_temporal_context`, `migrate_temporal_wiki_notes`, `find_orphan_notes`, `delegate_task` |
| **Researcher** | `read_webpage`, `search_web`, `query_wikipedia`, `search_vault`, `create_note`, `read_note`, `calculate_structural_holes`, `evaluate_information_gain`, `delegate_task` |

---

### 2.3 — Shift Deterministic Logic to TypeScript

**Problem:** The Gardener agent LLM-loops through `list_notes` → `search_vault` → `read_note` to find orphan notes, burning 3-5 tool iterations on something that can be computed deterministically.

#### [NEW] [find_orphan_notes tool](file:///Users/taha/PyCharmProjects/Pensieve/src/tools/discovery_tools.ts)
- Add a `find_orphan_notes` tool that uses `app.metadataCache.resolvedLinks` to deterministically compute orphan notes (notes with zero incoming links).
- Returns the list directly — no LLM needed for the computation.
- The LLM then uses `reparent_orphan_nodes` with the results (semantic reasoning only).

```ts
// Deterministic orphan detection
const allFiles = new Set(ctx.vault.getMarkdownFiles().map(f => f.path));
const hasIncoming = new Set<string>();
for (const [src, links] of Object.entries(resolvedLinks)) {
  for (const target of Object.keys(links)) hasIncoming.add(target);
}
const orphans = [...allFiles].filter(f => !hasIncoming.has(f));
```

---

## Phase 3: State Management & Performance

### 3.1 — Cure Sub-Agent Context Amnesia

**Problem:** `main.ts` line 82-83: sub-agents start with `chatHistory: []` and `ragContext: ""`, losing all context about what the parent was doing.

#### [MODIFY] [main.ts](file:///Users/taha/PyCharmProjects/Pensieve/src/main.ts)

1. Update `subAgentRunner.runSubAgent` to accept an optional `parentContext` string.
2. Pass the parent agent's current task description and RAG context summary as the sub-agent's `ragContext`.

#### [MODIFY] [agent_tools.ts](file:///Users/taha/PyCharmProjects/Pensieve/src/tools/agent_tools.ts)

1. Add an optional `context` parameter to `delegate_task` that the parent agent can populate.
2. Pass it through to `runSubAgent`.

#### [MODIFY] [types.ts](file:///Users/taha/PyCharmProjects/Pensieve/src/tools/types.ts)

1. Update `SubAgentRunner.runSubAgent` signature to include optional `parentContext`.

---

### 3.2 — Debounce Memory Compactor

**Problem:** `compactor.ts` fires after every chat resolution (lines 519, 576 in `chatview.ts`). With fast consecutive messages, this can create race conditions.

#### [MODIFY] [compactor.ts](file:///Users/taha/PyCharmProjects/Pensieve/src/compactor.ts)

1. Add a debounce timer (5-second window). Multiple calls within the window reset the timer.
2. Add a minimum message threshold — only compact if session has ≥ 4 new messages since last compaction.

```ts
private debounceTimer: ReturnType<typeof setTimeout> | null = null;
private readonly DEBOUNCE_MS = 5000;
private readonly MIN_NEW_MESSAGES = 4;

public scheduleCompaction(): void {
  if (this.debounceTimer) clearTimeout(this.debounceTimer);
  this.debounceTimer = setTimeout(() => this.checkAndCompact(), this.DEBOUNCE_MS);
}
```

#### [MODIFY] [chatview.ts](file:///Users/taha/PyCharmProjects/Pensieve/src/chatview.ts)

1. Replace `this.plugin.compactor.checkAndCompact()` calls with `this.plugin.compactor.scheduleCompaction()`.

---

### 3.3 — Non-Blocking Vector Search

**Problem:** `vectorstore.ts` `search()` runs a synchronous `Array.map` + `sort()` on the main Obsidian thread, causing UI freezing for large vaults.

#### [MODIFY] [vectorstore.ts](file:///Users/taha/PyCharmProjects/Pensieve/src/vectorstore.ts)

1. Make `search()` async.
2. Process entries in batches of ~500, yielding between batches via `setTimeout(resolve, 0)`.
3. Use a min-heap (top-K selection) instead of full `sort()` — O(n log k) instead of O(n log n).

```ts
async search(queryEmbedding: number[], topK: number): Promise<ScoredEntry[]> {
  const BATCH_SIZE = 500;
  const heap: ScoredEntry[] = [];
  
  for (let i = 0; i < this.entries.length; i += BATCH_SIZE) {
    const batch = this.entries.slice(i, i + BATCH_SIZE);
    for (const entry of batch) {
      const score = cosineSimilarity(queryEmbedding, entry.embedding);
      insertIntoHeap(heap, { entry, score }, topK);
    }
    // Yield to event loop
    if (i + BATCH_SIZE < this.entries.length) {
      await new Promise(r => setTimeout(r, 0));
    }
  }
  
  return heap.sort((a, b) => b.score - a.score);
}
```

#### Ripple effect: All callers of `search()` already use `await` on the retriever, so no caller changes needed.

---

## Phase 4: Missing Architectural Patterns

### 4.1 — Human-in-the-Loop (`ask_user` tool) — Yield & Resume Pattern

**Design:** No hanging Promises. The `ask_user` tool terminates the ReAct loop gracefully.

#### [NEW] [ask_user tool](file:///Users/taha/PyCharmProjects/Pensieve/src/tools/agent_tools.ts)

1. Define an `ask_user` tool with parameter `question: string`.
2. When executed, it returns a special `ToolResult` with a flag: `{ success: true, output: question, askUser: true }`.

#### [MODIFY] [react.ts](file:///Users/taha/PyCharmProjects/Pensieve/src/agents/react.ts)

1. After tool execution, check if `result.askUser === true`.
2. If so, immediately return an `AgentResult` where `answer` is the question text and a flag `needsUserInput: true`.
3. The ReAct loop terminates cleanly — no hanging state.

#### [MODIFY] [chatview.ts](file:///Users/taha/PyCharmProjects/Pensieve/src/chatview.ts)

1. When `result.needsUserInput` is true, render the question as an assistant bubble (styled as a question prompt).
2. The user's next message enters the normal `onSend()` flow.
3. The Orchestrator re-classifies, sees the context in `chatHistory`, and routes back to the same agent type.
4. The agent picks up naturally because the full conversation (including its question and the user's answer) is in the message history.

#### [MODIFY] [types.ts](file:///Users/taha/PyCharmProjects/Pensieve/src/agents/types.ts)

1. Add `needsUserInput?: boolean` to `AgentResult`.

---

### 4.2 — Reflexion (Self-Correction Loop)

#### [MODIFY] [orchestrator.ts](file:///Users/taha/PyCharmProjects/Pensieve/src/agents/orchestrator.ts)

1. After the `Editor` agent completes a writing task, check if the result contains a created/modified note.
2. If so, run a one-shot "Critic" prompt against the draft (not a full agent loop — just a single LLM call).
3. If the critic flags issues (heuristic: response contains words like "error", "incorrect", "missing", "flaw"), route back to the Editor with the critic's feedback for one more iteration.
4. Cap at 1 reflection cycle to prevent infinite loops.

```ts
async runAgentWithReflection(intent: IntentType, ctx: AgentContext): Promise<AgentResult> {
  const result = await this.runAgent(intent, ctx);
  
  if (intent === "editor" && result.affectedFiles.length > 0) {
    const criticFeedback = await this.runCriticCheck(result, ctx);
    if (criticFeedback.needsRevision) {
      // Re-run editor with feedback
      ctx.userQuery = `Revise your previous work. Critic feedback: ${criticFeedback.feedback}\n\nOriginal instructions: ${ctx.userQuery}`;
      return this.runAgent(intent, ctx);
    }
  }
  
  return result;
}
```

---

## Open Questions

> [!IMPORTANT]
> **Model Compatibility:** The default model is `gemma4:e2b`. Does this model support Ollama's native tool calling? If not, we should keep the XML fallback as a configurable option. Models known to support it: Llama 3.1+, Qwen 2.5+, Mistral v0.3+.

> [!IMPORTANT]
> **Streaming vs. Tool Calling Trade-off:** Ollama's native tool calling requires `stream: false`. Currently the ReAct loop doesn't stream to the user anyway (only `direct_chat` streams). Confirm this is acceptable — the user sees trace steps but doesn't see tokens stream during agent thinking.

> [!NOTE]
> **Phase ordering:** Phases 1 and 2 have dependencies (e.g., tool scoping depends on the `generateOllamaToolDefs` method from Phase 1.1). Phase 3 and 4 are largely independent. Proposed execution order: 1.1 → 1.3 → 1.4 → 1.2 → 2.1 → 2.2 → 2.3 → 3.1 → 3.2 → 3.3 → 4.1 → 4.2.

---

## Verification Plan

### Automated Tests
- Run `npm run build` after each phase to verify TypeScript compilation.
- Ensure no regressions in the build output (`main.js`).

### Manual Verification
After each phase, manually test in Obsidian:

1. **Phase 1:** 
   - Verify tool calling works with native Ollama format (ask agent to create a note)
   - Verify Researcher can ingest and synthesize a full URL
   - Verify Ontologist extracts triplets without JSON errors
   - Verify intent classification works with filler text ("I think you should write_task")

2. **Phase 2:**
   - Verify "organize my notes" routes to Librarian
   - Verify "write a daily note" routes to Editor
   - Verify "research this URL" routes to Researcher
   - Verify tool counts per agent (check trace prompts)

3. **Phase 3:**
   - Verify sub-agents receive parent context
   - Verify compactor doesn't fire on every message
   - Verify UI doesn't freeze during large vault searches

4. **Phase 4:**
   - Verify `ask_user` pauses and resumes the loop
   - Verify reflection catches obvious errors in drafts
