import type { App, Vault } from "obsidian";
import type { Retriever } from "../retriever";
import type { PensieveSettings } from "../settings";
import type { OllamaService } from "../ollama";
import type { GraphStore } from "../graphstore";

export interface ToolParam {
	name: string;
	type: "string" | "boolean" | "number";
	description: string;
	required: boolean;
}

export interface SubAgentRunResult {
	answer: string;
	affectedFiles: string[];
}

export interface SubAgentRunner {
	runSubAgent(intent: string, query: string, onTrace?: (step: any) => void): Promise<SubAgentRunResult>;
}

export interface TemporalContext {
	sessionId?: string;
	intent?: string;
	agentName?: string;
	eventType?: string;
}

export interface ToolContext {
	vault: Vault;
	app: App;
	retriever: Retriever;
	settings: PensieveSettings;
	ollama: OllamaService;
	subAgentRunner?: SubAgentRunner;
	graphStore?: GraphStore;
	temporalContext?: TemporalContext;
	currentToolName?: string;
	nextTemporalSequence?: () => number;
}

export interface ToolResult {
	success: boolean;
	output: string;
	affectedFile?: string;
	affectedFiles?: string[];
	executedAt?: number;
	durationMs?: number;
	/** If true, the ReAct loop should yield and present this output as a question to the user. */
	askUser?: boolean;
}

export interface Tool {
	name: string;
	description: string;
	parameters: ToolParam[];
	execute(args: Record<string, unknown>, ctx: ToolContext, onTrace?: (step: any) => void): Promise<ToolResult>;
}
