import type { OllamaMessage } from "../ollama";
import type { AgentContext, AgentResult, TraceStep } from "./types";

const REACT_FORMAT = `
## Response Format

To reason and use a tool:
<thought>Your reasoning about what to do next</thought>
<tool_call>{"name": "tool_name", "arguments": {"param": "value"}}</tool_call>

After seeing the observation, continue with more thoughts and tool calls as needed.

When you have finished all actions and are ready to reply to the user:
<thought>Brief summary of what was done</thought>
<final_answer>Your complete, friendly response to the user in markdown</final_answer>

Rules:
- ALWAYS wrap reasoning in <thought> tags before any action
- Use <tool_call> JSON exactly as shown — no extra text outside the tags on the same block
- Use <final_answer> ONLY when fully done — do not call any more tools after it
- Never call the same tool with the same arguments twice
- If a task requires massive context (like reading multiple huge files), use 'delegate_task' immediately.
`;

export async function runReActLoop(
	systemPrompt: string,
	ctx: AgentContext
): Promise<AgentResult> {
	const { ollama, settings, toolRegistry, toolCtx, onTrace } = ctx;
	const maxIterations = settings.maxAgentIterations ?? 10;
	const traceSteps: TraceStep[] = [];
	const affectedFiles: Set<string> = new Set();

	const messages: OllamaMessage[] = [
		{
			role: "system",
			content: systemPrompt + REACT_FORMAT + toolRegistry.generateSchemaPrompt(),
		},
		...ctx.chatHistory,
		{
			role: "user",
			content: ctx.ragContext
				? `**Vault context:**\n${ctx.ragContext}\n\n---\n**User Directive:**\n${ctx.userQuery}\n\nYou must strictly follow the ReAct formatting rules. Begin your response immediately with <thought>. Do not output conversational text.`
				: `${ctx.userQuery}\n\nYou must strictly follow the ReAct formatting rules. Begin your response immediately with <thought>. Do not output conversational text.`,
		},
	];

	onTrace({
		type: "prompt",
		content: JSON.stringify(messages, null, 2)
	});

	for (let iter = 0; iter < maxIterations; iter++) {
		let responseText = "";
		await ollama.chat(settings.chatModel, messages, (token) => {
			responseText += token;
		});

		// Emit thought
		const thought = toolRegistry.parseThought(responseText);
		if (thought) {
			const step: TraceStep = { type: "thought", content: thought };
			traceSteps.push(step);
			onTrace(step);
		}

		// Check for final answer
		const finalAnswer = toolRegistry.parseFinalAnswer(responseText);
		if (finalAnswer) {
			return { answer: finalAnswer, traceSteps, affectedFiles: [...affectedFiles] };
		}

		// Parse and execute tool call
		const toolCall = toolRegistry.parseToolCall(responseText);
		if (!toolCall) {
			// No tags at all — treat raw output as final answer
			const clean = responseText.replace(/<[^>]+>/g, "").trim();
			return { answer: clean || responseText, traceSteps, affectedFiles: [...affectedFiles] };
		}

		const callStep: TraceStep = {
			type: "tool_call",
			content: `Calling **${toolCall.name}** with arguments: \n\`\`\`json\n${JSON.stringify(toolCall.arguments, null, 2)}\n\`\`\``,
			toolName: toolCall.name,
			toolArgs: toolCall.arguments,
		};
		traceSteps.push(callStep);
		onTrace(callStep);

		const execStep: TraceStep = {
			type: "observation",
			content: "⏳ Executing tool (waiting for background response)..."
		};
		onTrace(execStep);

		const result = await toolRegistry.execute(toolCall.name, toolCall.arguments, toolCtx, onTrace);

		if (result.affectedFile) affectedFiles.add(result.affectedFile);

		const obsStep: TraceStep = {
			type: "observation",
			content: result.output,
			toolName: toolCall.name,
		};
		traceSteps.push(obsStep);
		onTrace(obsStep);

		// Feed observation back
		messages.push({ role: "assistant", content: responseText });
		messages.push({
			role: "user",
			content: `<observation>${result.success ? result.output : "Error: " + result.output}</observation>\n\nContinue.`,
		});

		// ── Iteration State Compactor ──────────────────────────────────────────
		// Retain the very first init messages, and the newest raw iteration. 
		// Compress the iteration that just aged out to prevent context destruction.
		const baseMsgCount = 2 + ctx.chatHistory.length;
		if (messages.length > baseMsgCount + 2) {
			const targetAstIdx = messages.length - 4; // The old assistant message
			const targetObsIdx = messages.length - 3; // The old user observation message

			if (messages[targetAstIdx] && messages[targetObsIdx]) {
				const oldAstText = messages[targetAstIdx].content;
				const oldThought = toolRegistry.parseThought(oldAstText) || "Continued reasoning.";
				const oldTool = toolRegistry.parseToolCall(oldAstText);
				messages[targetAstIdx].content = `[Past Iteration] Thought: ${oldThought}. Action: ${oldTool ? oldTool.name : "None"}.`;

				const oldObsText = messages[targetObsIdx].content;
				messages[targetObsIdx].content = oldObsText.length > 500 
					? oldObsText.substring(0, 500) + "\n... [Observation mathematically truncated to protect context window limit]"
					: oldObsText;
			}
		}
	}

	// Force final answer after max iterations
	messages.push({
		role: "user",
		content: "You have reached the step limit. Give your final answer now using <final_answer> tags.",
	});
	let forced = "";
	await ollama.chat(settings.chatModel, messages, (t) => { forced += t; });
	const ans = toolRegistry.parseFinalAnswer(forced) ?? forced.replace(/<[^>]+>/g, "").trim();
	return { answer: ans, traceSteps, affectedFiles: [...affectedFiles] };
}
