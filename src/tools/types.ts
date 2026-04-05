import type { App, Vault } from "obsidian";
import type { Retriever } from "../retriever";
import type { PensieveSettings } from "../settings";

export interface ToolParam {
	name: string;
	type: "string" | "boolean" | "number";
	description: string;
	required: boolean;
}

export interface ToolContext {
	vault: Vault;
	app: App;
	retriever: Retriever;
	settings: PensieveSettings;
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
	execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult>;
}
