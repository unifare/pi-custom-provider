// 测试替身：仅提供 relay.ts 运行时用到的两个值，其余皆为 import type（会被剥离）。
export function getAgentDir() {
	const d = process.env.PI_TEST_AGENT_DIR;
	if (!d) throw new Error("PI_TEST_AGENT_DIR not set");
	return d;
}

export async function withFileMutationQueue(_file, fn) {
	return fn();
}
