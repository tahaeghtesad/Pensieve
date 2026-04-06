import type { App, Vault } from "obsidian";
import type { Retriever } from "../retriever";
import type { PensieveSettings } from "../settings";
import type { OllamaService } from "../ollama";

export interface ToolParam {
	name: string;
	type: "string" | "boolean" | "number";
	description: string;
	required: boolean;
}

export interface SubAgentRunner {
	runSubAgent(intent: string, query: string, onTrace?: (step: any) => void): Promise<string>;
}

export interface ToolContext {
	vault: Vault;
	app: App;
	retriever: Retriever;
	settings: PensieveSettings;
	ollama: OllamaService;
	subAgentRunner?: SubAgentRunner;
}

export interface ToolResult {
	success: boolean;
	output: string;
	affectedFile?: string;
}

export interface Tool {
	name: string;
	description: string;
	parameters: ToolParam[];
	execute(args: Record<string, unknown>, ctx: ToolContext, onTrace?: (step: any) => void): Promise<ToolResult>;
}
