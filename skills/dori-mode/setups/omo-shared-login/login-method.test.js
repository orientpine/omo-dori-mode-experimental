import { describe, expect, test } from "bun:test";
import { homedir } from "node:os";
import { join } from "node:path";
import { chooseLoginMethod } from "./login-method.js";

// The installed pi-ai, the same one omo-login-share.ts loads. Nothing here reaches Anthropic or OpenAI.
const PIAI = join(homedir(), ".bun/install/global/node_modules/@earendil-works/pi-ai/dist");
const STOP = new Error("stop before any network call");

// Anthropic login is the Claude CLI's own login through senpi's oauth-login.js now (pi-ai no
// longer ships auth/oauth/anthropic.js); `omo-login-share login` answers its method prompt.
describe("chooseLoginMethod against the installed pi-ai login", () => {
	test("anthropic CLI login selects copy code before spawning or making a directory", async () => {
		const { createOAuthConfig } = await import(join(homedir(),
			".bun/install/global/node_modules/@code-yeongyu/senpi/dist/core/extensions/builtin/anthropic-subscription/oauth-login.js"));
		let selected;
		const config = createOAuthConfig({ readCurrent: async () => undefined });
		await expect(config.login({
			onSelect: async (prompt) => {
				selected = chooseLoginMethod("anthropic-subscription", prompt.options);
				throw STOP;
			},
		})).rejects.toBe(STOP);
		expect(selected).toBe("copy_code");
	});

	test("chatgpt login takes the legacy route, then browser login, each an offered id", async () => {
		const providers = await import(join(PIAI, "providers/all.js"));
		const oauth = providers.builtinProviders().find((provider) => provider.id === "chatgpt-subscription").auth.oauth;
		const offered = [];
		const interaction = {
			signal: new AbortController().signal,
			notify: () => {},
			prompt: async (prompt) => {
				if (prompt.type !== "select") throw STOP;
				offered.push(prompt.options);
				if (offered.length > 1) throw STOP;
				return chooseLoginMethod("chatgpt-subscription", prompt.options);
			},
		};
		await expect(oauth.login(interaction)).rejects.toBe(STOP);
		expect(chooseLoginMethod("chatgpt-subscription", offered[0])).toBe("legacy");
		expect(chooseLoginMethod("chatgpt-subscription", offered[1])).toBe("browser");
	});

	test("an unknown provider gets a headless option id, never an object", () => {
		const options = [
			{ id: "browser", label: "Browser login (default)" },
			{ id: "paste", label: "Paste login (headless)" },
		];
		expect(chooseLoginMethod("other", options)).toBe("paste");
		expect(() => chooseLoginMethod("other", [{ label: "no id" }])).toThrow("offers no method id");
	});
});
