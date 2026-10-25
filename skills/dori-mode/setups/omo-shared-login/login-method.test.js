import { describe, expect, test } from "bun:test";
import { homedir } from "node:os";
import { join } from "node:path";
import { chooseLoginMethod } from "./login-method.js";

// The installed pi-ai, the same one omo-login-share.ts loads. Nothing here reaches Anthropic or OpenAI.
const PIAI = join(homedir(), ".bun/install/global/node_modules/@earendil-works/pi-ai/dist");
const STOP = new Error("stop before any network call");

function fakeInteraction(providerId) {
	const seen = { selects: [], events: [], prompts: [] };
	const interaction = {
		signal: new AbortController().signal,
		notify: (event) => seen.events.push(event),
		prompt: async (prompt) => {
			seen.prompts.push(prompt.type);
			if (prompt.type === "select") {
				seen.selects.push(prompt.options);
				return chooseLoginMethod(providerId, prompt.options);
			}
			throw STOP;
		},
	};
	return { interaction, seen };
}

describe("chooseLoginMethod against the installed pi-ai login", () => {
	test("anthropic login takes copy code: the auth link, then a pasted code", async () => {
		const { anthropicOAuth } = await import(join(PIAI, "auth/oauth/anthropic.js"));
		const { interaction, seen } = fakeInteraction("anthropic-subscription");
		await expect(anthropicOAuth.login(interaction)).rejects.toBe(STOP);
		expect(seen.prompts).toEqual(["select", "manual_code"]);
		const link = new URL(seen.events.find((event) => event.type === "auth_url").url);
		expect(link.origin + link.pathname).toBe("https://claude.ai/oauth/authorize");
		expect(link.searchParams.get("redirect_uri")).toBe("https://platform.claude.com/oauth/code/callback");
	});

	test("chatgpt login takes browser login, an offered id", async () => {
		const providers = await import(join(PIAI, "providers/all.js"));
		const oauth = providers.builtinProviders().find((provider) => provider.id === "chatgpt-subscription").auth.oauth;
		const offered = [];
		const interaction = {
			signal: new AbortController().signal,
			notify: () => {},
			prompt: async (prompt) => {
				offered.push(prompt.options);
				throw STOP;
			},
		};
		await expect(oauth.login(interaction)).rejects.toBe(STOP);
		expect(chooseLoginMethod("chatgpt-subscription", offered[0])).toBe("browser");
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
