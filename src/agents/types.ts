import { runReActLoop } from "./react";
import type { OllamaMessage, OllamaService } from "../ollama";
import type { PensieveSettings } from "../settings";
import type { ToolRegistry } from "../tools/registry";
import type { ToolContext } from "../tools/types";

export type IntentType =
	| "direct_chat"
	| "editor"
	| "librarian"
	| "researcher";

export interface TraceStep {
	id?: string;
	type: "thought" | "tool_call" | "observation" | "agent_handoff" | "error" | "prompt" | "raw_response";
	content: string;
	toolName?: string;
	toolArgs?: Record<string, unknown>;
	isComplete?: boolean;
}

export interface AgentResult {
	answer: string;
	traceSteps: TraceStep[];
	affectedFiles: string[];
	needsUserInput?: boolean;
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
	abortSignal?: { aborted: boolean };
	allowedTools?: string[];
}

export abstract class ReActAgent {
	abstract readonly agentName: string;

	/** Tools this agent is allowed to use. If undefined, all tools are available. */
	readonly allowedTools?: string[];

	protected abstract buildSystemPrompt(ctx: AgentContext): string;

	async run(ctx: AgentContext): Promise<AgentResult> {
		return runReActLoop(this.buildSystemPrompt(ctx), {
			...ctx,
			allowedTools: this.allowedTools,
		});
	}
}
