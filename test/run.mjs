// pi-custom-provider headless 功能测试：node --experimental-strip-types test/run.mjs
import { register } from "node:module";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

register("./hooks.mjs", import.meta.url);
const relay = await import("../extensions/relay.ts");

// ---------- 每个用例独立的 agentDir ----------
function freshDir() {
	const d = mkdtempSync(join(tmpdir(), "pi-relay-test-"));
	process.env.PI_TEST_AGENT_DIR = d;
	return d;
}
function readModels(dir) {
	return JSON.parse(readFileSync(join(dir, "models.json"), "utf-8"));
}

// ---------- fake 工厂 ----------
function makePi() {
	return {
		commands: {},
		registered: [],
		unregistered: [],
		eventHandlers: {},
		setModelCalls: [],
		registerCommand(name, opts) {
			this.commands[name] = opts;
		},
		registerProvider(name, config) {
			this.registered.push({ name, config });
		},
		unregisterProvider(name) {
			this.unregistered.push(name);
		},
		on(event, handler) {
			this.eventHandlers[event] = handler;
		},
		async setModel(model) {
			this.setModelCalls.push(model);
			return true;
		},
	};
}

/** uiQueue: { inputs: Array<string|null>, selects: number[], confirms: boolean[] } */
function makeCtx(pi, { mode = "tui", uiQueue = {}, registryModels = [] } = {}) {
	const log = [];
	const q = {
		inputs: [...(uiQueue.inputs ?? [])],
		selects: [...(uiQueue.selects ?? [])],
		confirms: [...(uiQueue.confirms ?? [])],
	};
	return {
		ctx: {
			mode,
			cwd: "/tmp",
			ui: {
				async input() {
					const v = q.inputs.shift();
					return v === null ? undefined : v;
				},
				async select(_t, options) {
					const i = q.selects.shift();
					if (i === undefined || i === -1) return undefined;
					return options[i];
				},
				async confirm() {
					return q.confirms.shift() ?? false;
				},
				notify(message, type) {
					log.push({ message, type });
				},
				setStatus(k, v) {
					log.push({ status: `${k}=${v}` });
				},
			},
			modelRegistry: {
				find(provider, modelId) {
					return registryModels.find((m) => m.provider === provider && m.id === modelId);
				},
			},
		},
		log,
	};
}

let passed = 0;
async function ok(name, fn) {
	await fn();
	passed++;
	console.log(`ok - ${name}`);
}

// ================= 1. 纯函数 =================
await ok("normalize/isValidProviderId", async () => {
	assert.equal(relay.normalizeProviderId("My Relay"), "relay-my-relay");
	assert.equal(relay.normalizeProviderId("relay-x"), "relay-x");
	assert.ok(relay.isValidProviderId("relay-abc-123"));
	assert.ok(!relay.isValidProviderId("abc"));
	assert.ok(!relay.isValidProviderId("relay-UPPER"));
});

await ok("baseUrl 归一化/校验", async () => {
	assert.equal(relay.normalizeBaseUrl("https://a.com/v1///"), "https://a.com/v1");
	assert.ok(relay.isValidBaseUrl("http://localhost:11434/v1"));
	assert.ok(!relay.isValidBaseUrl("ftp://x"));
	assert.ok(!relay.isValidBaseUrl("not a url"));
});

await ok("parseModelIds 去重/分隔", async () => {
	assert.deepEqual(relay.parseModelIds("a, b  a\nc,, "), ["a", "b", "c"]);
});

await ok("parseArgs 支持 =/空格/引号", async () => {
	const o = relay.parseArgs('--name demo --baseUrl "https://x/v1" --api=openai-completions --key sk-1 --models "a, b"');
	assert.equal(o.name, "demo");
	assert.equal(o.baseUrl, "https://x/v1");
	assert.equal(o.api, "openai-completions");
	assert.equal(o.models, "a, b");
});

await ok("maskKey 脱敏", async () => {
	assert.match(relay.maskKey("sk-abcdefgh"), /efgh/);
	assert.match(relay.maskKey("$K"), /环境变量/);
	assert.match(relay.maskKey("!cmd"), /命令/);
	assert.equal(relay.maskKey(undefined), "(未设置)");
});

await ok("resolveKeyForTest", async () => {
	process.env.PI_RELAY_UT_KEY = "secret";
	assert.equal(relay.resolveKeyForTest("$PI_RELAY_UT_KEY"), "secret");
	assert.equal(relay.resolveKeyForTest("${PI_RELAY_UT_KEY}"), "secret");
	assert.equal(relay.resolveKeyForTest("plain"), "plain");
	assert.equal(relay.resolveKeyForTest("!cmd"), undefined);
	assert.equal(relay.resolveKeyForTest(undefined), undefined);
});

// ================= 2. 工厂注册命令 =================
await ok("工厂注册 6 个命令 + session_start", async () => {
	const pi = makePi();
	relay.default(pi);
	for (const c of ["relay", "relay-add", "relay-list", "relay-use", "relay-del", "relay-test"]) {
		assert.ok(pi.commands[c], c);
	}
	assert.ok(pi.eventHandlers.session_start, "session_start");
});

// ================= 3. 参数式新增 =================
await ok("参数式 relay-add 写文件 + 动态注册", async () => {
	const dir = freshDir();
	const pi = makePi();
	relay.default(pi);
	const { ctx, log } = makeCtx(pi, { mode: "print" });
	await pi.commands["relay-add"].handler(
		"--name demo --baseUrl https://x.example/v1/ --api openai-completions --key sk-abc --models a,b,a",
		ctx,
	);
	const file = readModels(dir);
	assert.equal(file.providers["relay-demo"].baseUrl, "https://x.example/v1");
	assert.equal(file.providers["relay-demo"].api, "openai-completions");
	assert.deepEqual(file.providers["relay-demo"].models, [{ id: "a" }, { id: "b" }]);
	assert.equal(pi.registered.length, 1);
	assert.equal(pi.registered[0].name, "relay-demo");
	assert.equal(pi.registered[0].config.models.length, 2);
	assert.ok(existsSync(join(dir, "models.json.bak")) === false, "首次写入无备份（文件原不存在）");
	assert.ok(log.some((l) => l.message.includes("已保存 relay-demo")));
});

// ================= 4. 坏文件不炸 =================
await ok("坏 models.json 读出空骨架", async () => {
	const dir = freshDir();
	writeFileSync(join(dir, "models.json"), "{oops", "utf-8");
	assert.deepEqual(relay.loadModelsFile(dir), { providers: {} });
});

// ================= 5. TUI 向导新增（env key） =================
await ok("TUI 向导新增 env key", async () => {
	const dir = freshDir();
	const pi = makePi();
	relay.default(pi);
	// selects: api 选第 0 个；key 方式选第 0 个(env)；最后 confirm 由 confirms 控制
	const { ctx } = makeCtx(pi, {
		uiQueue: {
			inputs: ["wiz", "https://w.example/v1", "MY_WIZ_KEY", "m1, m2"],
			selects: [0, 0],
			confirms: [true],
		},
	});
	await pi.commands["relay-add"].handler("", ctx);
	const file = readModels(dir);
	assert.equal(file.providers["relay-wiz"].apiKey, "$MY_WIZ_KEY");
	assert.deepEqual(
		file.providers["relay-wiz"].models.map((m) => m.id),
		["m1", "m2"],
	);
});

// ================= 6. relay-use 切换 =================
await ok("relay-use 切换模型", async () => {
	const dir = freshDir();
	const pi = makePi();
	relay.default(pi);
	const { ctx } = makeCtx(pi, { mode: "print" }, {});
	// 先种数据
	await pi.commands["relay-add"].handler("--name u --baseUrl https://u/x --api anthropic-messages --key $K --models m1", ctx);
	const { ctx: ctx2, log } = makeCtx(
		pi,
		{ mode: "print", registryModels: [{ provider: "relay-u", id: "m1" }] },
	);
	await pi.commands["relay-use"].handler("relay-u", ctx2);
	assert.equal(pi.setModelCalls.length, 1);
	assert.ok(log.some((l) => l.message.includes("已切换到 relay-u/m1")));
});

// ================= 7. relay-del =================
await ok("relay-del 删除 + 备份", async () => {
	const dir = freshDir();
	const pi = makePi();
	relay.default(pi);
	const { ctx } = makeCtx(pi, { mode: "print" });
	await pi.commands["relay-add"].handler("--name d --baseUrl https://d/x --api openai-completions --key k --models m", ctx);
	await pi.commands["relay-add"].handler("--name e --baseUrl https://e/x --api openai-completions --key k --models m", ctx);
	assert.ok(existsSync(join(dir, "models.json.bak")), "第二次写入应有备份");
	const { ctx: ctx2, log } = makeCtx(pi, { mode: "print" });
	await pi.commands["relay-del"].handler("relay-d", ctx2);
	assert.deepEqual(pi.unregistered, ["relay-d"]);
	const file = readModels(dir);
	assert.ok(!("relay-d" in file.providers));
	assert.ok("relay-e" in file.providers, "只删指定的");
	assert.ok(log.some((l) => l.message.includes("已删除")));
});

// ================= 8. session_start 状态栏 =================
await ok("session_start 写状态栏", async () => {
	const dir = freshDir();
	const pi = makePi();
	relay.default(pi);
	const { ctx } = makeCtx(pi, { mode: "print" });
	await pi.commands["relay-add"].handler("--name s --baseUrl https://s/x --api openai-completions --key k --models m", ctx);
	const { ctx: ctx2, log } = makeCtx(pi, { mode: "print" });
	await pi.eventHandlers.session_start({}, ctx2);
	assert.ok(log.some((l) => l.status === "relay=relay:1"));
});

// ================= 9. 非法参数抛错 =================
await ok("非法 api 抛错", async () => {
	freshDir();
	const pi = makePi();
	relay.default(pi);
	const { ctx } = makeCtx(pi, { mode: "print" });
	await assert.rejects(() =>
		pi.commands["relay-add"].handler("--name x --baseUrl https://x --api nope --key k --models m", ctx),
	);
});

console.log(`\nALL PASS (${passed})`);
