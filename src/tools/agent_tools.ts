import type { Tool, ToolResult } from "./types";
import { TraceStep } from "../agents/types";

export const delegateTaskTool: Tool = {
	name: "delegate_task",
	description: "Spawn a completely fresh, isolated sub-agent to handle a massive cognitive task without polluting your own context window. Useful for reading huge blocks of text, parsing heavy documents, or mapping long files. Returns the sub-agent's final synthesized answer.",
	parameters: [
		{ name: "intent", type: "string", description: "The agent category to spawn (must be one of: 'review_task', 'synthesize_task', 'plan_task', 'factcheck_task', 'write_task', 'archive_task', 'organize_task', 'ingest_url', 'garden_task')", required: true },
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
			const finalAnswer = await ctx.subAgentRunner.runSubAgent(intent, taskDescription, onTrace);
			return { success: true, output: `[Sub-Agent successfully executed task]\nSub-Agent Response:\n\n${finalAnswer}` };
		} catch (e) {
			return { success: false, output: `Sub-agent crashed: ${e}` };
		}
	}
};

export function registerAgentTools(registry: import("./registry").ToolRegistry): void {
	registry.register(delegateTaskTool);
}
