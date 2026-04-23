import type { Tool, ToolResult } from "./types";
import { TraceStep } from "../agents/types";

export const delegateTaskTool: Tool = {
	name: "delegate_task",
	description: "Spawn a completely fresh, isolated sub-agent to handle a massive cognitive task without polluting your own context window. Useful for reading huge blocks of text, parsing heavy documents, or mapping long files. Returns the sub-agent's final synthesized answer.",
	parameters: [
		{ name: "intent", type: "string", description: "The agent category to spawn (must be one of: 'editor', 'librarian', 'researcher')", required: true },
		{ name: "task_description", type: "string", description: "A highly specific instruction of what the sub-agent needs to accomplish and report back on.", required: true }
	],
	async execute(args, ctx, onTrace): Promise<ToolResult> {
		if (!ctx.subAgentRunner) {
			return { success: false, output: "Sub-agent runner is not available in this context." };
		}
		
		const intent = String(args["intent"] ?? "");
		const taskDescription = String(args["task_description"] ?? "");
		
		if (!intent || !taskDescription) return { success: false, output: "Both intent and task_description are required." };

		try {
			const subResult = await ctx.subAgentRunner.runSubAgent(intent, taskDescription, onTrace);
			const prettyIntent = intent
				.split(/[_\s-]+/)
				.filter(Boolean)
				.map((part) => part.charAt(0).toUpperCase() + part.slice(1))
				.join(" ") || "Subagent";
			return {
				success: true,
				output: `[${prettyIntent} Agent successfully executed task]\n${prettyIntent} Agent Response:\n\n${subResult.answer}`,
				affectedFile: subResult.affectedFiles.length > 0 ? subResult.affectedFiles[0] : undefined,
				affectedFiles: subResult.affectedFiles.length > 0 ? subResult.affectedFiles : undefined,
			};
		} catch (e) {
			return { success: false, output: `Sub-agent crashed: ${e}` };
		}
	}
};

export const askUserTool: Tool = {
	name: "ask_user",
	description: "Pause and ask the user a clarifying question before continuing. Use this when you need user confirmation for a destructive or ambiguous operation (e.g., renaming a folder, choosing between options, or confirming a bulk action). The ReAct loop will yield and the user's response will come back as the next message.",
	parameters: [
		{ name: "question", type: "string", description: "The question to present to the user. Be specific about what options they have.", required: true },
	],
	async execute(args, _ctx): Promise<ToolResult> {
		const question = String(args["question"] ?? "");
		if (!question) return { success: false, output: "A question is required." };

		return {
			success: true,
			output: `🤔 **Pensieve needs your input:**\n\n${question}`,
			askUser: true,
		};
	}
};

export function registerAgentTools(registry: import("./registry").ToolRegistry): void {
	registry.register(delegateTaskTool);
	registry.register(askUserTool);
}
