// pi-ai `select` login prompts offer { id, label } options and expect the chosen id string back.
// Anthropic: copy code (the owner pastes the code); ChatGPT: browser login (the owner pastes the final address).
// Keep the existing ChatGPT legacy account route; the current provider asks
// siwc/legacy first, then that legacy route asks browser/device_code.
const PREFERRED = { "anthropic-subscription": "copy_code", "chatgpt-subscription": "browser" };

export function chooseLoginMethod(providerId, options) {
	const list = Array.isArray(options) ? options : [];
	const pick =
		(providerId === "chatgpt-subscription" ? list.find((option) => option?.id === "legacy") : undefined) ??
		list.find((option) => option?.id === PREFERRED[providerId]) ??
		list.find((option) => /headless/i.test(option?.label ?? "")) ??
		list[0];
	if (typeof pick?.id !== "string") throw new Error(`login for ${providerId} offers no method id: ${JSON.stringify(list)}`);
	return pick.id;
}
