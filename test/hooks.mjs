// 把对 Pi 宿主的导入重定向到本地 mock，避免真机依赖。
export async function resolve(specifier, context, next) {
	if (specifier === "@earendil-works/pi-coding-agent") {
		return { url: new URL("./mock-pi.mjs", import.meta.url).href, shortCircuit: true };
	}
	return next(specifier, context);
}
