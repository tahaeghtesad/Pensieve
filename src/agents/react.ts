import type { OllamaMessage } from "../ollama";
import type { AgentContext, AgentResult, TraceStep } from "./types";

/**
 * Tools that produce large content which should not be aggressively truncated
 * during the iteration state compaction.
 */
const LARGE_CONTENT_TOOLS = new Set([
	"read_webpage", "query_wikipedia", "read_note", "get_knowledge_graph",
	"get_temporal_context", "compress_cluster",
]);

const REACT_SYSTEM_SUFFIX = `
## Response Format

You have access to tools via the Ollama native tool calling interface.
When you need to use a tool, the system will automatically format your tool call.

When you have finished all actions and are ready to reply to the user, respond with your complete answer in plain markdown. Do NOT call any more tools after your final response.

Rules:
- Use one tool at a time; wait for the observation before proceeding.
- Never call the same tool with the same arguments twice.
- If a task requires massive context (like reading multiple huge files), use 'delegate_task' immediately.
- When done, give your final answer directly — no special tags needed.
`;

export async function runReActLoop(
	systemPrompt: string,
	ctx: AgentContext
): Promise<AgentResult> {
	const { ollama, settings, toolRegistry, toolCtx, onTrace } = ctx;
	const maxIterations = settings.maxAgentIterations ?? 10;
	const traceSteps: TraceStep[] = [];
	const affectedFiles: Set<string> = new Set();

	// Resolve which tools this agent is allowed to use
	const allowedTools = ctx.allowedTools;
	const toolDefs = toolRegistry.generateOllamaToolDefs(allowedTools);

	const messages: OllamaMessage[] = [
		{
			role: "system",
			content: systemPrompt + REACT_SYSTEM_SUFFIX,
		},
		...ctx.chatHistory,
		{
			role: "user",
			content: ctx.ragContext
				? `**Vault context:**\n${ctx.ragContext}\n\n---\n**User Directive:**\n${ctx.userQuery}`
				: ctx.userQuery,
		},
	];

	onTrace({
		type: "prompt",
		content: JSON.stringify(messages, null, 2)
	});

	// Track which tool produced each observation for smart truncation
	const observationToolMap: Map<number, string> = new Map();

	for (let iter = 0; iter < maxIterations; iter++) {
		if (ctx.abortSignal?.aborted) {
			onTrace({ type: "observation", content: "Generation explicitly aborted." });
			return { answer: "Generation aborted by user.", traceSteps, affectedFiles: Array.from(affectedFiles) };
		}

		// Fire a "reasoning" trace to mask the non-streaming latency
		onTrace({ type: "observation", content: "⚙️ Agent is reasoning..." });

		// ── Call Ollama with native tool calling (non-streaming) ──────────
		const response = await ollama.chatWithTools(settings.chatModel, messages, toolDefs, ctx.abortSignal);
		const assistantMsg = response.message;

		const responseText = assistantMsg.content?.trim();
		const responseStep: TraceStep = {
			type: "raw_response",
			content: responseText || (assistantMsg.tool_calls?.length
				? `Requested tool call: ${assistantMsg.tool_calls.map((call) => call.function.name).join(", ")}`
				: "Model returned an empty response."),
		};
		traceSteps.push(responseStep);
		onTrace(responseStep);

		// Check for tool calls in the native response
		if (assistantMsg.tool_calls && assistantMsg.tool_calls.length > 0) {
			const toolCall = assistantMsg.tool_calls[0]!;
			const toolName = toolCall.function.name;
			const toolArgs = toolCall.function.arguments;

			// Emit thought if the model included text content alongside the tool call
			if (assistantMsg.content && assistantMsg.content.trim()) {
				const thoughtStep: TraceStep = { type: "thought", content: assistantMsg.content.trim() };
				traceSteps.push(thoughtStep);
				onTrace(thoughtStep);
			}

			const stepId = "tool_" + Date.now() + "_" + Math.random().toString(36).substr(2, 5);
			const callStep: TraceStep = {
				id: stepId,
				type: "tool_call",
				toolName,
				toolArgs,
				content: "⏳ Waiting for background response...",
				isComplete: false,
			};
			traceSteps.push(callStep);
			onTrace(callStep);

			const result = await toolRegistry.execute(toolName, toolArgs, toolCtx, onTrace);

			if (result.affectedFile) affectedFiles.add(result.affectedFile);
			if (result.affectedFiles) {
				for (const f of result.affectedFiles) affectedFiles.add(f);
			}

			// Check for ask_user yield pattern (Phase 4.1)
			if ((result as any).askUser) {
				return {
					answer: result.output,
					traceSteps,
					affectedFiles: [...affectedFiles],
					needsUserInput: true,
				};
			}

			callStep.content = result.output;
			callStep.isComplete = true;
			onTrace(callStep);

			// Push the assistant's tool call message into history
			messages.push({
				role: "assistant",
				content: assistantMsg.content || "",
				tool_calls: assistantMsg.tool_calls,
			});

			// Push the tool result back as a "tool" role message
			const toolResultMsgIdx = messages.length;
			messages.push({
				role: "tool",
				content: result.success ? result.output : "Error: " + result.output,
			});

			// Track which tool produced this observation
			observationToolMap.set(toolResultMsgIdx, toolName);

			// ── Iteration State Compactor ──────────────────────────────────
			// Compress old iterations to prevent context window destruction.
			// Keep the newest raw iteration intact. Compress the one that just aged out.
			const baseMsgCount = 2 + ctx.chatHistory.length;
			if (messages.length > baseMsgCount + 4) {
				// Find the oldest assistant+tool pair beyond the base messages
				const targetAstIdx = baseMsgCount;
				const targetToolIdx = baseMsgCount + 1;

				if (messages[targetAstIdx] && messages[targetToolIdx] &&
					messages[targetAstIdx].role === "assistant" && messages[targetToolIdx].role === "tool") {

					// Compress the old assistant message
					const oldContent = messages[targetAstIdx].content || "";
					const oldToolName = messages[targetAstIdx].tool_calls?.[0]?.function.name;
					messages[targetAstIdx] = {
						role: "assistant",
						content: `[Past Step] Called tool: ${oldToolName ?? "unknown"}. ${oldContent.slice(0, 100)}`,
					};

					// Smart truncation: check if the observation came from a large-content tool
					const obsToolName = observationToolMap.get(targetToolIdx) ?? "";
					const isLargeContent = LARGE_CONTENT_TOOLS.has(obsToolName);
					const truncLimit = isLargeContent ? 3000 : 500;

					const oldObsText = messages[targetToolIdx].content;
					if (oldObsText.length > truncLimit) {
						messages[targetToolIdx] = {
							role: "tool",
							content: oldObsText.substring(0, truncLimit) +
								`\n... [Observation truncated from ${oldObsText.length} to ${truncLimit} chars]`,
						};
					}
				}
			}

			continue;
		}

		// ── No tool call — model is giving a final answer ─────────────────
		// The model responded with content but no tool calls — this is the answer.
		if (responseText) {
			const thought = toolRegistry.parseThought(assistantMsg.content);
			if (thought) {
				const step: TraceStep = { type: "thought", content: thought };
				traceSteps.push(step);
				onTrace(step);
			}

			// Check for explicit <final_answer> tags (backward compat)
			const finalAnswer = toolRegistry.parseFinalAnswer(assistantMsg.content);
			if (finalAnswer) {
				return { answer: finalAnswer, traceSteps, affectedFiles: [...affectedFiles] };
			}

			// No tags — treat raw content as final answer
			const clean = assistantMsg.content.replace(/<[^>]+>/g, "").trim();
			return { answer: clean || assistantMsg.content, traceSteps, affectedFiles: [...affectedFiles] };
		}

		// Empty response — shouldn't happen, but bail gracefully
		return {
			answer: "The agent produced an empty response. Please try again.",
			traceSteps,
			affectedFiles: [...affectedFiles],
		};
	}

	// ── Force final answer after max iterations (streaming for typewriter effect) ──
	messages.push({
		role: "user",
		content: "You have reached the step limit. Give your final answer now. Respond with a complete, helpful summary of what was accomplished.",
	});

	let forced = "";
	await ollama.chat(settings.chatModel, messages, (t) => { forced += t; });
	const ans = toolRegistry.parseFinalAnswer(forced) ?? forced.replace(/<[^>]+>/g, "").trim();
	return { answer: ans, traceSteps, affectedFiles: [...affectedFiles] };
}
