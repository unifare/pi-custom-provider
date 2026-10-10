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

function hostCore(host: string): string {
	const h = host.toLowerCase().split(":")[0];
	if (/^[\d.]+$/.test(h) || h === "localhost" || h === "") return "local";
	const labels = h.split(".").filter(Boolean);
	if (labels.length >= 2) return labels[labels.length - 2];
	return labels[0] ?? "custom";
}

/** 按域名自动生成 relay id（siliconflow.cn → relay-siliconflow），已占用自动加 -2/-3。 */
export function suggestProviderId(baseUrl: string, taken: Set<string>): string {
	let core = "custom";
	try {
		core = hostCore(new URL(baseUrl).hostname);
	} catch {
		// 非法 URL 由调用方校验，这里只管生成
	}
	const clean = core
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 24);
	const base = `relay-${clean || "custom"}`;
	if (!taken.has(base)) return base;
	let n = 2;
	while (taken.has(`${base}-${n}`)) n++;
	return `${base}-${n}`;
}

/** 同一地址已被哪些 relay 用过（比较归一化后的 baseUrl）。 */
export function findByBaseUrl(file: ModelsFileShape, baseUrl: string, exceptId?: string): string[] {
	const norm = normalizeBaseUrl(baseUrl);
	return Object.entries(file.providers ?? {})
		.filter(([id, e]) => id !== exceptId && normalizeBaseUrl(e.baseUrl) === norm)
		.map(([id]) => id);
}

/** 同一 $ENV 引用被哪些 relay 共用。 */
export function findEnvUsage(file: ModelsFileShape, envRef: string, exceptId?: string): string[] {
	if (!envRef.startsWith("$")) return [];
	return Object.entries(file.providers ?? {})
		.filter(([id, e]) => id !== exceptId && e.apiKey === envRef)
		.map(([id]) => id);
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

export interface RelayState {
	lastBaseUrl?: string;
	lastApi?: string;
}

export function stateFilePath(agentDir?: string): string {
	return join(agentDir ?? getAgentDir(), "relay-state.json");
}

/** 上次用过的 baseUrl/api（失败/不存在返回空对象，不抛）。 */
export function loadRelayState(agentDir?: string): RelayState {
	try {
		const p = stateFilePath(agentDir);
		if (!existsSync(p)) return {};
		const parsed = JSON.parse(readFileSync(p, "utf-8")) as RelayState;
		return typeof parsed === "object" && parsed !== null ? parsed : {};
	} catch {
		return {};
	}
}

export function saveRelayState(state: RelayState, agentDir?: string): void {
	try {
		const dir = agentDir ?? getAgentDir();
		mkdirSync(dir, { recursive: true });
		writeFileSync(stateFilePath(dir), `${JSON.stringify(state, null, 2)}\n`, "utf-8");
	} catch {
		// 状态存不住不影响主流程
	}
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

export interface FetchedModels {
	ok: boolean;
	ids: string[];
	error?: string;
}

function extractIds(data: unknown): string[] {
	if (!data || typeof data !== "object") return [];
	const rec = data as Record<string, unknown>;
	// OpenAI 兼容：{ data: [{ id }] }
	if (Array.isArray(rec.data)) {
		const ids: string[] = [];
		for (const item of rec.data) {
			if (item && typeof item === "object" && typeof (item as { id?: unknown }).id === "string") {
				const id = (item as { id: string }).id.trim();
				if (id && !ids.includes(id)) ids.push(id);
			}
		}
		if (ids.length > 0) return ids;
	}
	// Gemini：{ models: [{ name: "models/xxx" }] }
	if (Array.isArray(rec.models)) {
		const ids: string[] = [];
		for (const item of rec.models) {
			if (item && typeof item === "object" && typeof (item as { name?: unknown }).name === "string") {
				const id = (item as { name: string }).name.replace(/^models\//, "").trim();
				if (id && !ids.includes(id)) ids.push(id);
			}
		}
		if (ids.length > 0) return ids;
	}
	return [];
}

/**
 * 自动拉取中转的模型列表。
 * OpenAI 兼容：GET {baseUrl}/models；Google 系追加 ?key= 尝试。Anthropic 兼容一般无此端点，调用方回落手动填写。
 */
export async function fetchModelIds(baseUrl: string, api: string, apiKey?: string): Promise<FetchedModels> {
	const key = resolveKeyForTest(apiKey);
	const base = baseUrl.replace(/\/+$/, "");
	const headers: Record<string, string> = {};
	if (key) headers["Authorization"] = `Bearer ${key}`;
	const attempts = [`${base}/models`];
	if (api.startsWith("google-") && key) attempts.push(`${base}/models?key=${encodeURIComponent(key)}`);
	let lastError = "unknown";
	for (const url of attempts) {
		try {
			const res = await fetch(url, { headers, signal: AbortSignal.timeout(15000) });
			if (!res.ok) {
				lastError = `HTTP ${res.status}`;
			continue;
			}
			const ids = extractIds(await res.json());
			if (ids.length > 0) return { ok: true, ids };
			lastError = "响应中没有模型";
		} catch (err) {
			lastError = err instanceof Error ? err.message : String(err);
		}
	}
	return { ok: false, ids: [], error: lastError };
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

async function pickApi(ctx: ExtensionCommandContext, lastApi?: string): Promise<string | undefined> {
	const ordered = [...API_CHOICES].sort((a, b) =>
		a.value === lastApi ? -1 : b.value === lastApi ? 1 : 0,
	);
	const options = ordered.map((c) => `${c.value} — ${c.hint}`);
	const picked = await ctx.ui.select("选择接口类型（回车即第一个）", options);
	if (!picked) {
		ctx.ui.notify("已取消。", "info");
		return undefined;
	}
	return picked.split(" — ")[0];
}

/**
 * Key 一次输完，自动识别：$开头=环境变量，!开头=命令，其他=明文（二次确认）。
 * Exported 供参数式复用校验。
 */
export function normalizeApiKeyInput(raw: string): { key?: string; error?: string } {
	const value = raw.trim();
	if (!value) return { error: "Key 为空" };
	if (value.startsWith("$")) {
		const name = value.startsWith("${") ? value.slice(2, -1) : value.slice(1);
		if (!isValidEnvName(name)) return { error: `非法的环境变量名：${value}` };
		return { key: value };
	}
	if (value.startsWith("!")) {
		if (value.length < 2 || !value.slice(1).trim()) return { error: "命令为空" };
		return { key: value };
	}
	return { key: value };
}

async function inputApiKey(ctx: ExtensionCommandContext): Promise<string | undefined> {
	const raw = await inputOrAbort(ctx, "API Key", "$MY_RELAY_KEY（$开头=环境变量，!开头=命令，其他按明文存）");
	if (!raw) return undefined;
	const parsed = normalizeApiKeyInput(raw);
	if (!parsed.key) {
		ctx.ui.notify(parsed.error ?? "Key 非法", "error");
		return undefined;
	}
	if (!raw.startsWith("$") && !raw.startsWith("!")) {
		const ok = await ctx.ui.confirm("确认保存明文？", `该 key 将明文写入 ${modelsFilePath()}。\n建议改用 $ENV 引用。继续吗？`);
		if (!ok) {
			ctx.ui.notify("已取消。", "info");
			return undefined;
		}
	}
	return parsed.key;
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

	const remembered = loadRelayState();
	let baseUrl: string;
	if (remembered.lastBaseUrl) {
		const choice = await ctx.ui.select("Base URL", [`沿用上次：${remembered.lastBaseUrl}`, "输入新的…"]);
		if (!choice) {
			ctx.ui.notify("已取消。", "info");
			return undefined;
		}
		if (choice.startsWith("沿用上次：")) {
			baseUrl = remembered.lastBaseUrl;
		} else {
			const rawUrl = await inputOrAbort(ctx, "Base URL", "https://api.example.com/v1");
			if (!rawUrl) return undefined;
			baseUrl = normalizeBaseUrl(rawUrl);
		}
	} else {
		const rawUrl = await inputOrAbort(ctx, "Base URL", "https://api.example.com/v1");
		if (!rawUrl) return undefined;
		baseUrl = normalizeBaseUrl(rawUrl);
	}
	if (!isValidBaseUrl(baseUrl)) {
		ctx.ui.notify(`URL 不合法：${baseUrl}`, "error");
		return undefined;
	}

	const api = await pickApi(ctx, remembered.lastApi);
	if (!api) return undefined;

	const apiKey = await inputApiKey(ctx);
	if (!apiKey) return undefined;

	// 自动拉取模型列表，拉到后用列表确认（直接回车即第 1 个，可继续多选/全选），拉不到回落手动填写
	let modelIds: string[];
	if (ctx.mode === "tui") ctx.ui.notify("正在拉取模型列表…", "info");
	const fetched = await fetchModelIds(baseUrl, api, apiKey);
	if (fetched.ok && fetched.ids.length > 0) {
		if (ctx.mode !== "tui") {
			modelIds = fetched.ids;
		} else {
			const confirmed = await confirmModels(ctx, fetched.ids);
			if (!confirmed) return undefined;
			modelIds = confirmed;
		}
	} else {
		if (ctx.mode === "tui") {
			ctx.ui.notify(`自动获取失败（${fetched.error ?? "无数据"}），请手动填写。`, "warning");
			const rawModels = await inputOrAbort(ctx, "模型 ID（逗号分隔）", "gpt-5.4, claude-sonnet-4-6");
			if (!rawModels) return undefined;
			modelIds = parseModelIds(rawModels);
		} else {
		ctx.ui.notify(`自动获取失败（${fetched.error ?? "无数据"}），请用 --models 参数指定。`, "error");
		return undefined;
		}
	}
	if (modelIds.length === 0) {
		ctx.ui.notify("至少保留一个模型 ID。", "error");
		return undefined;
	}

	saveRelayState({ lastBaseUrl: baseUrl, lastApi: api });
	return { id, baseUrl, api, apiKey, modelIds };
}

/**
 * 列表确认模型：直接回车即第 1 个；之后可“就这几个 / 全选 / 继续多选 / 手动追加”。
 * 任意一步 Esc 即取消整个新增（返回 undefined）。
 */
async function confirmModels(ctx: ExtensionCommandContext, fetchedIds: string[]): Promise<string[] | undefined> {
	const first = await ctx.ui.select(`确认模型（共 ${fetchedIds.length} 个，直接回车取第 1 个）`, fetchedIds);
	if (!first) {
		ctx.ui.notify("已取消。", "info");
		return undefined;
	}
	const picked: string[] = [first];
	for (;;) {
		const rest = fetchedIds.filter((id) => !picked.includes(id));
		const options = [
			`就这 ${picked.length} 个，完成`,
			`全选（共 ${fetchedIds.length} 个）`,
				...(rest.length > 0 ? [`继续选…（还剩 ${rest.length} 个）`] : []),
				"手动输入…",
		];
		const act = await ctx.ui.select(`已选：${picked.join(", ")}`, options);
		if (!act) {
			ctx.ui.notify("已取消。", "info");
			return undefined;
		}
		if (act.startsWith("就这")) return picked;
		if (act.startsWith("全选")) return [...fetchedIds];
		if (act.startsWith("继续选")) {
			const more = await ctx.ui.select("继续选（直接回车取第 1 个）", rest);
			if (more && !picked.includes(more)) picked.push(more);
			continue;
		}
		const raw = await inputOrAbort(ctx, "模型 ID（逗号分隔，追加到已选）", "gpt-5.4");
		if (!raw) continue;
		for (const id of parseModelIds(raw)) {
			if (!picked.includes(id)) picked.push(id);
		}
	}
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

async function saveDraft(pi: ExtensionAPI, ctx: ExtensionCommandContext, d: RelayDraft, note?: string): Promise<void> {
	const entry = {
		baseUrl: d.baseUrl,
		api: d.api,
		apiKey: d.apiKey,
		models: d.modelIds.map((id) => ({ id })),
	};
	await writeRelayProvider(d.id, entry);
	registerDynamic(pi, d.id, entry);
	ctx.ui.notify(`已保存 ${d.id}。去 /model 选择 ${d.id}/${d.modelIds[0]} 即可使用。${note ?? ""}`, "info");
}

/** $ENV 被多个 relay 共用时的提示（只存引用所以允许共用，不阻断）。 */
function envShareNote(file: ModelsFileShape, apiKey: string): string {
	const users = findEnvUsage(file, apiKey);
	return users.length > 0 ? `注：${apiKey} 已被 ${users.join("、")} 在用，将共用同一 Key；不同 Key 请换变量名。` : "";
}

/**
 * 快速新增：只输地址和 Key，其余全默认/自动——
 * 名字按域名自动生成（重复自动 -2/-3）、接口默认 openai-completions、模型自动全拉。
 * 非 OpenAI 兼容（拉不到列表）自动降级进自定义流程。返回 true 表示成功加了一个。
 */
async function quickAdd(pi: ExtensionAPI, ctx: ExtensionCommandContext): Promise<boolean> {
	const remembered = loadRelayState();
	const rawUrl = await inputOrAbort(ctx, "Base URL（中转地址）", remembered.lastBaseUrl ?? "https://api.example.com/v1");
	if (!rawUrl) return false;
	const baseUrl = normalizeBaseUrl(rawUrl);
	if (!isValidBaseUrl(baseUrl)) {
		ctx.ui.notify(`URL 不合法：${baseUrl}`, "error");
		return false;
	}

	// 同一地址已配过 → 给出路，不直接报错
	const dups = findByBaseUrl(loadModelsFile(), baseUrl);
	if (dups.length > 0) {
		const choice = await ctx.ui.select(`该地址已被 ${dups.join("、")} 使用`, [
			"仍然添加",
			`切换到 ${dups[0]}`,
			"取消",
		]);
		if (!choice || choice === "取消") {
			ctx.ui.notify("已取消。", "info");
			return false;
		}
		if (choice.startsWith("切换到")) {
			await cmdUse(pi, dups[0], ctx);
			return false;
		}
	}

	const apiKey = await inputApiKey(ctx);
	if (!apiKey) return false;

	const DEFAULT_API = "openai-completions";
	ctx.ui.notify("正在识别接口并拉取模型列表…", "info");
	let api = DEFAULT_API;
	let modelIds: string[];
	const fetched = await fetchModelIds(baseUrl, DEFAULT_API, apiKey);
	if (fetched.ok && fetched.ids.length > 0) {
		modelIds = fetched.ids;
	} else {
		// 非 OpenAI 兼容 → 降级：选接口 + 按该接口再拉一次 → 还不行就手动填
		ctx.ui.notify(`自动识别失败（${fetched.error ?? "无数据"}），转自定义流程。`, "warning");
		const customApi = await pickApi(ctx, remembered.lastApi);
		if (!customApi) return false;
		api = customApi;
		const retry = await fetchModelIds(baseUrl, api, apiKey);
		if (retry.ok && retry.ids.length > 0) {
			const confirmed = await confirmModels(ctx, retry.ids);
			if (!confirmed) return false;
			modelIds = confirmed;
		} else {
			const rawModels = await inputOrAbort(ctx, "模型 ID（逗号分隔）", "gpt-5.4");
			if (!rawModels) return false;
			modelIds = parseModelIds(rawModels);
			if (modelIds.length === 0) {
				ctx.ui.notify("至少填一个模型 ID。", "error");
				return false;
			}
		}
	}

	const file = loadModelsFile();
	const id = suggestProviderId(baseUrl, new Set(Object.keys(file.providers ?? {})));
	const draft: RelayDraft = { id, baseUrl, api, apiKey, modelIds };
	const note = envShareNote(file, apiKey);
	const ok = await ctx.ui.confirm("确认保存？", note ? `${previewDraft(draft)}\n${note}` : previewDraft(draft));
	if (!ok) {
		ctx.ui.notify("已取消。", "info");
		return false;
	}
	await saveDraft(pi, ctx, draft);
	saveRelayState({ lastBaseUrl: baseUrl, lastApi: api });
	return true;
}

async function cmdAdd(pi: ExtensionAPI, args: string, ctx: ExtensionCommandContext): Promise<void> {
	const opts = parseArgs(args);
	// 参数不够（缺 baseUrl/key）→ TUI 向导：--custom 进逐项版，否则快速新增
	const hasMin = opts["baseUrl"] && opts["key"];
	if (!hasMin) {
		if (opts["help"] || !requireTui(ctx)) {
			if (opts["help"] || ctx.mode !== "tui") {
				ctx.ui.notify(
					"用法 /relay-add --baseUrl URL --key KEY [--api openai-completions] [--models a,b] [--name X]（TUI 下直接运行进入快速新增，可连加；--custom 进逐项向导）",
					"info",
				);
			}
			return;
		}
		// --custom 进逐项向导；否则 TUI 快速新增（可连加）
		if (opts["custom"]) {
			const draft = await wizardAdd(ctx);
			if (!draft) return;
			const note = envShareNote(loadModelsFile(), draft.apiKey);
			const ok = await ctx.ui.confirm("确认保存？", note ? `${previewDraft(draft)}\n${note}` : previewDraft(draft));
			if (!ok) {
				ctx.ui.notify("已取消。", "info");
				return;
			}
			await saveDraft(pi, ctx, draft);
			return;
		}
		for (;;) {
			const added = await quickAdd(pi, ctx);
			if (!added) break;
			const more = await ctx.ui.confirm("再加一个？", "继续添加下一个中转（地址可沿用上次）。");
			if (!more) break;
		}
		return;
	}

	// 参数式（非 TUI 也可用）：只要求 baseUrl + key，其余默认/自动
	const baseUrl = normalizeBaseUrl(String(opts["baseUrl"]));
	if (!isValidBaseUrl(baseUrl)) throw new Error(`非法 URL：${baseUrl}`);
	const api = opts["api"] ? String(opts["api"]) : "openai-completions";
	if (!API_VALUES.has(api)) throw new Error(`非法 api：${api}（可选 ${[...API_VALUES].join(" / ")}）`);
	const parsedKey = normalizeApiKeyInput(String(opts["key"]));
	if (!parsedKey.key) throw new Error(parsedKey.error ?? "非法 key");
	let modelIds = opts["models"] ? parseModelIds(String(opts["models"])) : [];
	if (modelIds.length === 0) {
		const fetched = await fetchModelIds(baseUrl, api, parsedKey.key);
		if (!fetched.ok || fetched.ids.length === 0) {
			throw new Error(`拉不到模型列表（${fetched.error ?? "无数据"}），请用 --models 指定`);
		}
		modelIds = fetched.ids;
	}
	const file = loadModelsFile();
	const id = opts["name"]
		? normalizeProviderId(String(opts["name"]))
		: suggestProviderId(baseUrl, new Set(Object.keys(file.providers ?? {})));
	if (!isValidProviderId(id)) throw new Error(`非法名字：${id}`);
	if (file.providers?.[id]) throw new Error(`${id} 已存在（参数式不自动改名，请换 --name）`);
	await saveDraft(pi, ctx, { id, baseUrl, api, apiKey: parsedKey.key, modelIds }, envShareNote(file, parsedKey.key));
	saveRelayState({ lastBaseUrl: baseUrl, lastApi: api });
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
	const fetched = await fetchModelIds(entry.baseUrl, entry.api, entry.apiKey);
	if (fetched.ok) {
		ctx.ui.notify(`连通 OK：${id} → ${fetched.ids.length} 个模型（${fetched.ids.slice(0, 5).join(", ")}${fetched.ids.length > 5 ? "…" : ""}）`, "info");
	} else if (fetched.error?.includes("404")) {
		ctx.ui.notify(`${id} 地址可达，但无 /models 端点（Anthropic 兼容属正常），请直接 /model 试用。`, "warning");
	} else {
		ctx.ui.notify(`连通失败：${fetched.error}`, "error");
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
				"add — 快速新增（只输地址和 Key，可连加）",
				"custom — 自定义新增（命名 / 接口 / 逐个选模型）",
				"list — 列表 / 切换 / 测试 / 删除",
				"use — 切换到某中转模型",
				"test — 测连通性",
				"del — 删除中转",
			]);
			if (!action) return;
			const verb = action.split(" — ")[0];
			if (verb === "add") await cmdAdd(pi, "", ctx);
			else if (verb === "custom") await cmdAdd(pi, "--custom", ctx);
			else if (verb === "list") await cmdList(pi, args, ctx);
			else if (verb === "use") await cmdUse(pi, args, ctx);
			else if (verb === "test") await cmdTest(pi, args, ctx);
			else if (verb === "del") await cmdDel(pi, args, ctx);
		},
	});

	pi.registerCommand("relay-add", {
		description: "快速新增中转（默认全自动；--custom 逐项控制）",
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
