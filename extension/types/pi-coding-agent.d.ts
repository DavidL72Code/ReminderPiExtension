/**
 * Minimal local type declarations for the Pi extension API.
 *
 * The real package is provided by the Pi runtime; this file lets the
 * extension and its tests type-check without depending on Pi's install
 * path or a node_modules stub that npm would prune.
 */
declare module "@earendil-works/pi-coding-agent" {
	export interface ExtensionContext {
		ui: {
			notify(message: string, type: string): void;
			confirm(title: string, message: string): Promise<boolean>;
			setWidget?(
				key: string,
				content: string[] | undefined,
				options?: { placement?: "aboveEditor" | "belowEditor" },
			): void;
		};
		shutdown(): void;
		sessionManager: unknown;
		mode: string;
		hasUI: boolean;
	}

	export interface ExtensionAPI {
		on(
			event: string,
			handler: (event: unknown, ctx: ExtensionContext) => Promise<void> | void,
		): void;
		registerCommand(
			name: string,
			config: {
				description?: string;
				handler: (args: string, ctx: ExtensionContext) => Promise<void>;
			},
		): void;
		registerTool(tool: unknown): void;
		/** Append a custom message to the transcript. */
		sendMessage?(
			message: {
				customType: string;
				content: string;
				display?: boolean;
				details?: unknown;
			},
			options?: { triggerTurn?: boolean },
		): void;
	}
}
