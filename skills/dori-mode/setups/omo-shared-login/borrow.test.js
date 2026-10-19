import { describe, expect, test } from "bun:test";
import { borrowDocument, holdsNoGrant, PLACEHOLDER } from "./borrow.js";

const source = {
	"anthropic-subscription": {
		type: "oauth",
		access: "claude-sdk-oauth-managed",
		refresh: "claude-sdk-oauth-managed",
		expires: 4102444800000,
		accounts: [
			{ name: "default", access: "A1", refresh: "R1", expires: 10, source: "login", blockReason: "rate_limit", blockedUntil: 5 },
			{ name: "second", access: "A2", refresh: "R2", expires: 20, source: "login" },
		],
	},
	xai: { type: "oauth", access: "X1", refresh: "XR1", expires: 30 },
	openrouter: { type: "api_key", key: "source-key" },
};

describe("borrowDocument", () => {
	test("replaces every usable refresh with the placeholder and keeps the sentinel", () => {
		const { next } = borrowDocument(source, {});
		const anthropic = next["anthropic-subscription"];
		expect(anthropic.refresh).toBe("claude-sdk-oauth-managed");
		expect(anthropic.accounts.map((slot) => slot.refresh)).toEqual([PLACEHOLDER, PLACEHOLDER]);
		expect(anthropic.accounts.map((slot) => slot.access)).toEqual(["A1", "A2"]);
		expect(next.xai.refresh).toBe(PLACEHOLDER);
		expect(holdsNoGrant(next)).toBe(true);
		expect(holdsNoGrant(source)).toBe(false);
	});

	test("does not copy the source's own blocks or non-OAuth keys", () => {
		const { next } = borrowDocument(source, {});
		expect(next["anthropic-subscription"].accounts[0].blockReason).toBeUndefined();
		expect(next.openrouter).toBeUndefined();
	});

	test("keeps the borrower's rate limit and pin, drops its auth_error once the token is new", () => {
		const borrower = {
			"anthropic-subscription": {
				type: "oauth",
				pinned: "second",
				accounts: [
					{ name: "default", access: "OLD", refresh: PLACEHOLDER, expires: 1, blockReason: "auth_error", blockedUntil: 99, authRecoveryGrant: "g" },
					{ name: "second", access: "OLD2", refresh: PLACEHOLDER, expires: 1, blockReason: "rate_limit", blockedUntil: 77 },
				],
			},
		};
		const { next } = borrowDocument(source, borrower);
		const [first, second] = next["anthropic-subscription"].accounts;
		expect(first.blockReason).toBeUndefined();
		expect(first.authRecoveryGrant).toBeUndefined();
		expect(second.blockReason).toBe("rate_limit");
		expect(second.blockedUntil).toBe(77);
		expect(next["anthropic-subscription"].pinned).toBe("second");
	});

	test("keeps an auth_error recorded against the token it still holds", () => {
		const borrower = {
			"anthropic-subscription": { type: "oauth", accounts: [{ name: "default", access: "A1", refresh: PLACEHOLDER, expires: 10, blockReason: "auth_error", blockedUntil: 99 }] },
		};
		const { next } = borrowDocument(source, borrower);
		expect(next["anthropic-subscription"].accounts[0].blockReason).toBe("auth_error");
	});

	test("removes OAuth logins the source does not have and keeps the borrower's API keys", () => {
		const borrower = { "kimi-coding": { type: "oauth", access: "K", refresh: "KR", expires: 1 }, openai: { type: "api_key", key: "mine" } };
		const { next, removed } = borrowDocument(source, borrower);
		expect(removed).toEqual(["kimi-coding"]);
		expect(next["kimi-coding"]).toBeUndefined();
		expect(next.openai).toEqual({ type: "api_key", key: "mine" });
	});

	test("is idempotent", () => {
		const once = borrowDocument(source, {}).next;
		const twice = borrowDocument(source, once).next;
		expect(JSON.stringify(twice)).toBe(JSON.stringify(once));
	});
});
