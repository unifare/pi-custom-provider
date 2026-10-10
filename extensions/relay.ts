import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// M0 占位：M1 在此实现 /relay 系列命令。
// 设计见 ../PLAN.md（方案 A：只读写 models.json，复用内置 api 实现）。
export default function relayExtension(pi: ExtensionAPI) {
	pi.registerCommand("relay", {
		description: "Manage custom relay endpoints (TUI wizard, no manual file editing)",
		handler: async (_args, ctx) => {
			if (ctx.mode !== "tui") {
				ctx.ui.notify("relay wizard requires interactive mode. Use /relay-add --help in print/json mode.", "error");
				return;
			}
			ctx.ui.notify("M1 未实现：下一步做 /relay-add 向导（见 PLAN.md §4）", "warning");
		},
	});
}
