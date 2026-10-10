/**
 * pi-custom-provider — 在 Pi TUI 里管理自定义中转 provider
 *
 * 方案 A（配置层）：只读写 global `models.json` 的 `relay-*` 命名空间，
 * 复用 Pi 内置 api 实现（openai-completions 等），不写 streamSimple。
 * 写完后 `/model` 打开即重载；本插件同时做一次动态 register，让本 session 立即可用。
 *
 * 命令：/relay /relay-add /relay-list /relay-use /relay-del /relay-test
 */

import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Api, Model } from "@earendil-works/pi-ai";
import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
	ProviderModelConfig,
} from "@earendil-works/pi-coding-agent";
import { getAgentDir, withFileMutationQueue } from "@earendil-works/pi-coding-agent";

// ---------------------------------------------------------------------------
// 常量
// ---------------------------------------------------------------------------

const RELAY_PREFIX = "relay-";
const MODELS_FILE = "models.json";
const MODELS_BACKUP = "models.json.bak";

const API_CHOICES: Array<{ value: string; hint: string }> = [
	{ value: "openai-completions", hint: "OpenAI 聊天接口（大多数中转 / Ollama / vLLM / LM Studio）" },
	{ value: "openai-responses", hint: "OpenAI Responses 接口" },
	{ value: "anthropic-messages", hint: "Anthropic Messages 接口" },
	{ value: "google-generative-ai", hint: "Google Gemini 接口" },
	{ value: "google-vertex", hint: "Google Vertex AI 接口" },
	{ value: "azure-openai-responses", hint: "Azure OpenAI Responses" },
	{ value: "mistral-conversations", hint: "Mistral Conversations" },
];
const API_VALUES = new Set(API_CHOICES.map((c) => c.value));

// 动态注册时给未知模型的兜底元数据（models.json 是 source of truth）。
const DEFAULT_CONTEXT_WINDOW = 128000;
const DEFAULT_MAX_TOKENS = 8192;

// ---------------------------------------------------------------------------
// 数据结构
// ---------------------------------------------------------------------------

export interface RelayProviderEntry {
	baseUrl: string;
	api: string;
	apiKey?: string;
	models: Array<{ id: string }>;
}

interface ModelsFileShape {
	providers?: Record<string, RelayProviderEntry>;
	[key: string]: unknown;
}

// ---------------------------------------------------------------------------
// 纯函数（可单元测试）
// ---------------------------------------------------------------------------

export function normalizeProviderId(raw: string): string {
	let id = raw.trim().toLowerCase().replace(/\s+/g, "-");
	if (id && !id.startsWith(RELAY_PREFIX)) id = RELAY_PREFIX + id;
	return id;
}

export function isValidProviderId(id: string): boolean {
	return /^relay-[a-z0-9-]{1,56}$/.test(id);
}

export function normalizeBaseUrl(raw: string): string {
	return raw.trim().replace(/\/+$/, "");
}

export function isValidBaseUrl(u: string): boolean {
	return /^https?:\/\/[^/\s]+(\/\S*)?$/.test(u);
}

export function parseModelIds(raw: string): string[] {
	const seen = new Set<string>();
	for (const part of raw.split(/[,\s]+/)) {
		const id = part.trim();
		if (id && !seen.has(id)) seen.add(id);
	}
	return [...seen];
}

export function isValidEnvName(name: string): boolean {
	return /^[A-Za-z_][A-Za-z0-9_]*$/.test(name);
}

export function maskKey(key: string | undefined): string {
	if (!key) return "(未设置)";
	if (key.startsWith("$")) return `(${key} 引用环境变量)`;
	if (key.startsWith("!")) return `(!${key.slice(1, 12)}… 命令输出)`;
	if (key.length <= 8) return "**** (明文落盘)";
	return `${"*".repeat(4)}${key.slice(-4)} (明文落盘)`;
}

/** 极简 --key value / --key=value 解析（支持双引号）。 */
export function parseArgs(args: string): Record<string, string | true> {
	const out: Record<string, string | true> = {};
	const tokens = args.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) ?? [];
	for (let i = 0; i < tokens.length; i++) {
		const tok = tokens[i];
		if (!tok.startsWith("--")) continue;
		const eq = tok.indexOf("=");
		if (eq !== -1) {
			out[tok.slice(2, eq)] = stripQuotes(tok.slice(eq + 1));
		} else {
			const key = tok.slice(2);
			const next = tokens[i + 1];
			if (next && !next.startsWith("--")) {
				out[key] = stripQuotes(next);
				i++;
			} else {
				out[key] = true;
			}
		}
	}
	return out;
}

function stripQuotes(s: string): string {
	const doubleQuoted = s.startsWith('"') && s.endsWith('"');
	const singleQuoted = s.startsWith("'") && s.endsWith("'");
	if ((doubleQuoted || singleQuoted) && s.length >= 2) {
		return s.slice(1, -1);
	}
	return s;
}

export function modelsFilePath(agentDir?: string): string {
	return join(agentDir ?? getAgentDir(), MODELS_FILE);
}

/** 读 models.json（不存在/坏掉时返回空骨架，不抛）。 */
export function loadModelsFile(agentDir?: string): ModelsFileShape {
	const path = modelsFilePath(agentDir);
	if (!existsSync(path)) return { providers: {} };
	try {
		const parsed = JSON.parse(readFileSync(path, "utf-8")) as ModelsFileShape;
		if (!parsed.providers || typeof parsed.providers !== "object") parsed.providers = {};
		return parsed;
	} catch {
		return { providers: {} };
	}
}

export function listRelayProviders(file: ModelsFileShape): Array<{ id: string; entry: RelayProviderEntry }> {
	return Object.entries(file.providers ?? {})
		.filter(([id]) => id.startsWith(RELAY_PREFIX))
		.map(([id, entry]) => ({ id, entry }));
}

export function describeRelay(id: string, entry: RelayProviderEntry): string {
	const models = entry.models.map((m) => m.id).join(", ") || "(空)";
	return `${id} | ${entry.api} | ${models} | ${entry.baseUrl}`;
}

function toDynamicModels(modelIds: string[]): ProviderModelConfig[] {
	return modelIds.map((id) => ({
		id,
		name: id,
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: DEFAULT_CONTEXT_WINDOW,
		maxTokens: DEFAULT_MAX_TOKENS,
	}));
}

// ---------------------------------------------------------------------------
// 文件写操作（走 mutation queue + 备份）
// ---------------------------------------------------------------------------

export async function writeRelayProvider(
	id: string,
	entry: RelayProviderEntry,
	agentDir?: string,
): Promise<void> {
	const path = modelsFilePath(agentDir);
	await withFileMutationQueue(path, async () => {
		const dir = agentDir ?? getAgentDir();
		mkdirSync(dir, { recursive: true });
		if (existsSync(path)) {
			try {
				copyFileSync(path, join(dir, MODELS_BACKUP));
			} catch {
				// 备份失败不阻断写入
			}
		}
		const file = loadModelsFile(dir);
		file.providers = file.providers ?? {};
		file.providers[id] = entry;
		writeFileSync(path, `${JSON.stringify(file, null, 2)}\n`, "utf-8");
	});
}

export async function deleteRelayProvider(id: string, agentDir?: string): Promise<boolean> {
	const path = modelsFilePath(agentDir);
	return withFileMutationQueue(path, async () => {
		const dir = agentDir ?? getAgentDir();
		const file = loadModelsFile(dir);
		if (!file.providers || !(id in file.providers)) return false;
		if (existsSync(path)) {
			try {
				copyFileSync(path, join(dir, MODELS_BACKUP));
			} catch {
				// 忽略备份失败
			}
		}
		delete file.providers[id];
		writeFileSync(path, `${JSON.stringify(file, null, 2)}\n`, "utf-8");
		return true;
	});
}

/** 本 session 内即时生效（不等待 /model 重载；models.json 仍是 source of truth）。 */
export function registerDynamic(pi: ExtensionAPI, id: string, entry: RelayProviderEntry): void {
	try {
		pi.registerProvider(id, {
			baseUrl: entry.baseUrl,
			apiKey: entry.apiKey,
			api: entry.api as Api,
			models: toDynamicModels(entry.models.map((m) => m.id)),
		});
	} catch {
		// 已被其他扩展注册等情况：忽略，/model 重载后以文件为准
	}
}

/** 仅 $ENV 引用可解析；明文直接用；!command 不解析（测试时跳过鉴权头）。 */
export function resolveKeyForTest(key: string | undefined): string | undefined {
	if (!key) return undefined;
	if (key.startsWith("$")) {
		const name = key.startsWith("${") ? key.slice(2, -1) : key.slice(1);
		return process.env[name];
	}
	if (key.startsWith("!")) return undefined;
	return key;
}

// ---------------------------------------------------------------------------
// TUI 小件
// ---------------------------------------------------------------------------

function requireTui(ctx: ExtensionCommandContext): boolean {
	if (ctx.mode === "tui") return true;
	ctx.ui.notify("该向导需要 TUI 模式；print/json 模式请用参数式（见 /relay-add --help）。", "error");
	return false;
}

async function inputOrAbort(
	ctx: ExtensionCommandContext,
	title: string,
	placeholder?: string,
): Promise<string | undefined> {
	const value = await ctx.ui.input(title, placeholder);
	if (value === undefined || !value.trim()) {
		ctx.ui.notify("已取消。", "info");
		return undefined;
	}
	return value.trim();
}

async function pickApi(ctx: ExtensionCommandContext): Promise<string | undefined> {
	const options = API_CHOICES.map((c) => `${c.value} — ${c.hint}`);
	const picked = await ctx.ui.select("选择接口类型", options);
	if (!picked) {
		ctx.ui.notify("已取消。", "info");
		return undefined;
	}
	return picked.split(" — ")[0];
}

async function inputApiKey(ctx: ExtensionCommandContext): Promise<string | undefined> {
	const kind = await ctx.ui.select("API Key 保存方式", [
		"env — 引用环境变量（推荐，如 $MY_RELAY_KEY）",
		"plain — 直接填写明文（落盘到 models.json）",
		"cmd — 命令输出（!command，请求时执行）",
	]);
	if (!kind) {
		ctx.ui.notify("已取消。", "info");
		return undefined;
	}
	const mode = kind.split(" — ")[0];
	if (mode === "env") {
		const name = await inputOrAbort(ctx, "环境变量名", "MY_RELAY_KEY");
		if (!name) return undefined;
		if (!isValidEnvName(name)) {
			ctx.ui.notify(`非法的环境变量名：${name}`, "error");
			return undefined;
		}
		return `$${name}`;
	}
	if (mode === "cmd") {
		const cmd = await inputOrAbort(ctx, "取 Key 的命令", "op read ux-key --no-newline");
		if (!cmd) return undefined;
		return cmd.startsWith("!") ? cmd : `!${cmd}`;
	}
	const plain = await inputOrAbort(ctx, "API Key 明文", "sk-...");
	if (!plain) return undefined;
	const ok = await ctx.ui.confirm("确认保存明文？", `该 key 将明文写入 ${modelsFilePath()}。\n建议改用 env 引用。继续吗？`);
	if (!ok) {
		ctx.ui.notify("已取消。", "info");
		return undefined;
	}
	return plain;
}

// ---------------------------------------------------------------------------
// 业务流
// ---------------------------------------------------------------------------

interface RelayDraft {
	id: string;
	baseUrl: string;
	api: string;
	apiKey: string;
	modelIds: string[];
}

async function wizardAdd(ctx: ExtensionCommandContext): Promise<RelayDraft | undefined> {
	const rawName = await inputOrAbort(ctx, "中转名字（自动加 relay- 前缀）", "my-relay");
	if (!rawName) return undefined;
	const id = normalizeProviderId(rawName);
	if (!isValidProviderId(id)) {
		ctx.ui.notify(`名字不合法（展开后为 ${id}，只允许小写字母/数字/连字符）。`, "error");
		return undefined;
	}
	const file = loadModelsFile();
	if (file.providers?.[id]) {
		ctx.ui.notify(`${id} 已存在，请用 /relay-list 编辑或换个名字。`, "error");
		return undefined;
	}

	const rawUrl = await inputOrAbort(ctx, "Base URL", "https://api.example.com/v1");
	if (!rawUrl) return undefined;
	const baseUrl = normalizeBaseUrl(rawUrl);
	if (!isValidBaseUrl(baseUrl)) {
		ctx.ui.notify(`URL 不合法：${baseUrl}`, "error");
		return undefined;
	}

	const api = await pickApi(ctx);
	if (!api) return undefined;

	const apiKey = await inputApiKey(ctx);
	if (!apiKey) return undefined;

	const rawModels = await inputOrAbort(ctx, "模型 ID（逗号分隔）", "gpt-5.4, claude-sonnet-4-6");
	if (!rawModels) return undefined;
	const modelIds = parseModelIds(rawModels);
	if (modelIds.length === 0) {
		ctx.ui.notify("至少填一个模型 ID。", "error");
		return undefined;
	}

	return { id, baseUrl, api, apiKey, modelIds };
}

function previewDraft(d: RelayDraft): string {
	return [
		`provider: ${d.id}`,
		`baseUrl: ${d.baseUrl}`,
		`api: ${d.api}`,
		`apiKey: ${maskKey(d.apiKey)}`,
		`models: ${d.modelIds.join(", ")}`,
	].join("\n");
}

async function saveDraft(pi: ExtensionAPI, ctx: ExtensionCommandContext, d: RelayDraft): Promise<void> {
	await writeRelayProvider(d.id, {
		baseUrl: d.baseUrl,
		api: d.api,
		apiKey: d.apiKey,
		models: d.modelIds.map((id) => ({ id })),
	});
	registerDynamic(pi, d.id, {
		baseUrl: d.baseUrl,
		api: d.api,
		apiKey: d.apiKey,
		models: d.modelIds.map((id) => ({ id })),
	});
	ctx.ui.notify(`已保存 ${d.id}。去 /model 选择 ${d.id}/${d.modelIds[0]} 即可使用。`, "info");
}

async function cmdAdd(pi: ExtensionAPI, args: string, ctx: ExtensionCommandContext): Promise<void> {
	const opts = parseArgs(args);
	const hasAll = opts["name"] && opts["baseUrl"] && opts["api"] && opts["key"] && opts["models"];

	// 参数不全 → TUI 向导
	if (!hasAll) {
		if (opts["help"] || !requireTui(ctx)) {
			if (opts["help"] || ctx.mode !== "tui") {
				ctx.ui.notify(
					"用法 /relay-add --name X --baseUrl URL --api openai-completions --key KEY --models a,b（TUI 下直接运行进入向导）",
					"info",
				);
			}
			return;
		}
		const draft = await wizardAdd(ctx);
		if (!draft) return;
		const ok = await ctx.ui.confirm("确认保存？", previewDraft(draft));
		if (!ok) {
			ctx.ui.notify("已取消。", "info");
			return;
		}
		await saveDraft(pi, ctx, draft);
		return;
	}

	// 参数式（非 TUI 也可用）
	const id = normalizeProviderId(String(opts["name"]));
	const baseUrl = normalizeBaseUrl(String(opts["baseUrl"]));
	const api = String(opts["api"]);
	const modelIds = parseModelIds(String(opts["models"]));
	if (!isValidProviderId(id)) throw new Error(`非法名字：${id}`);
	if (!isValidBaseUrl(baseUrl)) throw new Error(`非法 URL：${baseUrl}`);
	if (!API_VALUES.has(api)) throw new Error(`非法 api：${api}（可选 ${[...API_VALUES].join(" / ")}）`);
	if (modelIds.length === 0) throw new Error("models 为空");
	await saveDraft(pi, ctx, {
		id,
		baseUrl,
		api,
		apiKey: String(opts["key"]),
		modelIds,
	});
}

async function pickRelay(ctx: ExtensionCommandContext, title: string): Promise<string | undefined> {
	const relays = listRelayProviders(loadModelsFile());
	if (relays.length === 0) {
		ctx.ui.notify("还没有 relay-* 中转，先跑 /relay-add 新增一个。", "warning");
		return undefined;
	}
	const options = relays.map(({ id, entry }) => describeRelay(id, entry));
	const picked = await ctx.ui.select(title, options);
	if (!picked) return undefined;
	return picked.split(" | ")[0];
}

async function cmdList(pi: ExtensionAPI, args: string, ctx: ExtensionCommandContext): Promise<void> {
	const relays = listRelayProviders(loadModelsFile());
	if (relays.length === 0) {
		ctx.ui.notify("还没有 relay-* 中转，先跑 /relay-add 新增一个。", "warning");
		return;
	}
	if (ctx.mode !== "tui") {
		ctx.ui.notify(relays.map(({ id, entry }) => describeRelay(id, entry)).join("\n"), "info");
		return;
	}
	const id = await pickRelay(ctx, "已配置的中转（回车进入操作）");
	if (!id) return;
	const action = await ctx.ui.select(`${id} → 操作`, ["use — 切换到该模型", "test — 测连通性", "del — 删除", "back — 返回"]);
	if (!action) return;
	const verb = action.split(" — ")[0];
	if (verb === "use") await cmdUse(pi, id, ctx);
	else if (verb === "test") await cmdTest(pi, id, ctx);
	else if (verb === "del") await cmdDel(pi, id, ctx);
}

async function ensureInRegistry(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	id: string,
): Promise<boolean> {
	const file = loadModelsFile();
	const entry = file.providers?.[id];
	if (!entry) return false;
	// 文件是 source of truth；先动态注册一次，保证本 session 可用
	registerDynamic(pi, id, entry);
	return true;
}

async function cmdUse(pi: ExtensionAPI, args: string, ctx: ExtensionCommandContext): Promise<void> {
	let id = args.trim().split(/\s+/)[0];
	if (!id && ctx.mode === "tui") {
		const picked = await pickRelay(ctx, "选择要使用的中转");
		if (!picked) return;
		id = picked;
	}
	if (!id) {
		ctx.ui.notify("用法：/relay-use relay-id [model-id]", "info");
		return;
	}
	if (!(await ensureInRegistry(pi, ctx, id))) {
		ctx.ui.notify(`找不到 ${id}（只管理 relay-*）。`, "error");
		return;
	}
	const entry = loadModelsFile().providers?.[id];
	const modelIds = entry?.models.map((m) => m.id) ?? [];
	let modelId = args.trim().split(/\s+/)[1] ?? modelIds[0];
	if (!modelId) {
		ctx.ui.notify(`${id} 下没有模型。`, "error");
		return;
	}
	if (!modelIds.includes(modelId) && ctx.mode === "tui" && modelIds.length > 1) {
		const picked = await ctx.ui.select(`选择 ${id} 的模型`, modelIds);
		if (!picked) return;
		modelId = picked;
	}
	const model = ctx.modelRegistry.find(id, modelId) as Model<Api> | undefined;
	if (!model) {
		ctx.ui.notify(`registry 里找不到 ${id}/${modelId}，先打开一次 /model（触发重载）再试。`, "warning");
		return;
	}
	const ok = await pi.setModel(model);
	ctx.ui.notify(ok ? `已切换到 ${id}/${modelId}` : `${id}/${modelId} 缺少可用鉴权，检查 key。`, ok ? "info" : "error");
}

async function cmdDel(pi: ExtensionAPI, args: string, ctx: ExtensionCommandContext): Promise<void> {
	let id = args.trim();
	if (!id && ctx.mode === "tui") {
		const picked = await pickRelay(ctx, "选择要删除的中转");
		if (!picked) return;
		id = picked;
	}
	if (!id) {
		ctx.ui.notify("用法：/relay-del relay-id", "info");
		return;
	}
	const entry = loadModelsFile().providers?.[id];
	if (!entry) {
		ctx.ui.notify(`找不到 ${id}。`, "error");
		return;
	}
	if (ctx.mode === "tui") {
		const ok = await ctx.ui.confirm("确认删除？", `${describeRelay(id, entry)}\n删除后 models.json.bak 留有备份。`);
		if (!ok) {
			ctx.ui.notify("已取消。", "info");
			return;
		}
	}
	try {
		pi.unregisterProvider(id);
	} catch {
		// 未注册时忽略
	}
	const removed = await deleteRelayProvider(id);
	ctx.ui.notify(removed ? `已删除 ${id}` : `找不到 ${id}`, removed ? "info" : "error");
}

async function cmdTest(_pi: ExtensionAPI, args: string, ctx: ExtensionCommandContext): Promise<void> {
	let id = args.trim();
	if (!id && ctx.mode === "tui") {
		const picked = await pickRelay(ctx, "选择要测试的中转");
		if (!picked) return;
		id = picked;
	}
	if (!id) {
		ctx.ui.notify("用法：/relay-test relay-id", "info");
		return;
	}
	const entry = loadModelsFile().providers?.[id];
	if (!entry) {
		ctx.ui.notify(`找不到 ${id}。`, "error");
		return;
	}
	const key = resolveKeyForTest(entry.apiKey);
	const headers: Record<string, string> = {};
	if (key) headers["Authorization"] = `Bearer ${key}`;
	let url = "";
	try {
		url = `${entry.baseUrl.replace(/\/+$/, "")}/models`;
		const res = await fetch(url, { headers, signal: AbortSignal.timeout(15000) });
		const text = await res.text();
		if (res.ok) {
			let count = "(解析失败)";
			try {
				const data = JSON.parse(text) as { data?: unknown[] };
				if (Array.isArray(data.data)) count = `${data.data.length} 个模型`;
			} catch {
				// 非 OpenAI 格式也算通
			}
			ctx.ui.notify(`连通 OK：${id} → ${count}`, "info");
		} else if (res.status === 404) {
			ctx.ui.notify(`${id} 地址可达，但无 /models 端点（Anthropic 兼容属正常），请直接 /model 试用。`, "warning");
		} else {
			ctx.ui.notify(`连通失败：HTTP ${res.status} ${text.slice(0, 200)}`, "error");
		}
	} catch (err) {
		ctx.ui.notify(`连通失败：${url || entry.baseUrl}（${err instanceof Error ? err.message : String(err)}）`, "error");
	}
}

// ---------------------------------------------------------------------------
// 入口
// ---------------------------------------------------------------------------

export default function relayExtension(pi: ExtensionAPI) {
	pi.registerCommand("relay", {
		description: "管理自定义中转（新增/列表/切换/删除/测试，全 TUI）",
		handler: async (args, ctx) => {
			if (ctx.mode !== "tui") {
				ctx.ui.notify("TUI 下运行 /relay 进入主菜单；print/json 模式请用 /relay-add --help 看参数式用法。", "info");
				return;
			}
			const action = await ctx.ui.select("中转管理", [
				"add — 新增中转（向导）",
				"list — 列表 / 切换 / 测试 / 删除",
				"use — 切换到某中转模型",
				"test — 测连通性",
				"del — 删除中转",
			]);
			if (!action) return;
			const verb = action.split(" — ")[0];
			if (verb === "add") await cmdAdd(pi, args, ctx);
			else if (verb === "list") await cmdList(pi, args, ctx);
			else if (verb === "use") await cmdUse(pi, args, ctx);
			else if (verb === "test") await cmdTest(pi, args, ctx);
			else if (verb === "del") await cmdDel(pi, args, ctx);
		},
	});

	pi.registerCommand("relay-add", {
		description: "新增自定义中转（TUI 向导 / 参数式）",
		handler: async (args, ctx) => cmdAdd(pi, args, ctx),
	});

	pi.registerCommand("relay-list", {
		description: "列出已配置的中转",
		handler: async (args, ctx) => cmdList(pi, args, ctx),
	});

	pi.registerCommand("relay-use", {
		description: "切换到某中转模型",
		handler: async (args, ctx) => cmdUse(pi, args, ctx),
	});

	pi.registerCommand("relay-del", {
		description: "删除某中转",
		handler: async (args, ctx) => cmdDel(pi, args, ctx),
	});

	pi.registerCommand("relay-test", {
		description: "测试中转连通性",
		handler: async (args, ctx) => cmdTest(pi, args, ctx),
	});

	// 状态栏显示中转数量（只读，不注册 provider，避免与 models.json 双源冲突）
	pi.on("session_start", async (_event, ctx: ExtensionContext) => {
		try {
			const n = listRelayProviders(loadModelsFile()).length;
			ctx.ui.setStatus("relay", n > 0 ? `relay:${n}` : undefined);
		} catch {
			// 状态栏失败不影响启动
		}
	});
}
