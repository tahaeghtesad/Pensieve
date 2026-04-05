import { runReActLoop } from "./react";
import type { OllamaMessage, OllamaService } from "../ollama";
import type { PensieveSettings } from "../settings";
import type { ToolRegistry } from "../tools/registry";
import type { ToolContext } from "../tools/types";

export type IntentType =
	| "direct_chat"
	| "write_task"
	| "plan_task"
	| "review_task"
	| "factcheck_task";

export interface TraceStep {
	type: "thought" | "tool_call" | "observation" | "agent_handoff" | "error";
	content: string;
	toolName?: string;
	toolArgs?: Record<string, unknown>;
}

export interface AgentResult {
	answer: string;
	traceSteps: TraceStep[];
	affectedFiles: string[];
}

export interface AgentContext {
	userQuery: string;
	chatHistory: OllamaMessage[];
	ragContext: string;
	toolCtx: ToolContext;
	toolRegistry: ToolRegistry;
	ollama: OllamaService;
	settings: PensieveSettings;
	onTrace: (step: TraceStep) => void;
}

export abstract class ReActAgent {
	abstract readonly agentName: string;

	protected abstract buildSystemPrompt(ctx: AgentContext): string;

	async run(ctx: AgentContext): Promise<AgentResult> {
		return runReActLoop(this.buildSystemPrompt(ctx), ctx);
	}
}
