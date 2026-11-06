import { describe, expect, test } from "bun:test";
import { borrowCliCredential, borrowDocument, cliExpiresAt, cliSnapshotsFrom, connectionCheck, holdsNoGrant, PLACEHOLDER } from "./borrow.js";
import { homedir } from "node:os";
import { join } from "node:path";

// The installed senpi's own check of a Claude CLI auth block, the same one borrowers run.
const { isForeignAuthBlock } = await import(join(homedir(),
	".bun/install/global/node_modules/@code-yeongyu/senpi/dist/core/extensions/builtin/anthropic-subscription/accounts.js"));

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

	test("a claude-cli slot travels as identity only and keeps the borrower's blocks", () => {
		const cliSource = { "anthropic-subscription": { type: "oauth", accounts: [
			{ name: "default", store: "claude-cli", dirId: "d1", access: "A", refresh: "R", expires: 9, blockReason: "auth_error", blockedUntil: 5 },
		] } };
		const borrower = { "anthropic-subscription": { type: "oauth", accounts: [
			{ name: "default", store: "claude-cli", dirId: "d1", blockReason: "rate_limit", blockedUntil: 70 },
		] } };
		const [slot] = borrowDocument(cliSource, borrower).next["anthropic-subscription"].accounts;
		expect([slot.access, slot.refresh, slot.expires]).toEqual([undefined, undefined, undefined]);
		expect([slot.store, slot.dirId]).toEqual(["claude-cli", "d1"]);
		expect([slot.blockReason, slot.blockedUntil]).toEqual(["rate_limit", 70]);
	});

	const cliSource = (dirId) => ({ "anthropic-subscription": { type: "oauth", accounts: [{ name: "default", store: "claude-cli", dirId }] } });
	const verdictBlocked = { name: "default", store: "claude-cli", dirId: "d1", blockReason: "auth_error", blockedUntil: 90, blockedAt: 40,
		authVerdict: { dirId: "d1", at: 40 }, signInRequired: "login_expired", modelBlocks: { m: 1 } };

	test("a claude-cli auth block keeps its verdict for the same login, so senpi still honours it", () => {
		const borrower = { "anthropic-subscription": { type: "oauth", accounts: [verdictBlocked] } };
		const [slot] = borrowDocument(cliSource("d1"), borrower).next["anthropic-subscription"].accounts;
		expect(slot).toEqual(verdictBlocked);
		expect(isForeignAuthBlock({ ...slot, signInRequired: undefined })).toBe(false);
	});

	test("a source rate limit never overwrites the borrower's expired-login auth block for the same login", () => {
		const source = { "anthropic-subscription": { type: "oauth", accounts: [
			{ name: "default", store: "claude-cli", dirId: "d1", blockReason: "rate_limit", blockedUntil: 999, blockedAt: 500 },
		] } };
		const borrower = { "anthropic-subscription": { type: "oauth", accounts: [verdictBlocked] } };
		const [slot] = borrowDocument(source, borrower).next["anthropic-subscription"].accounts;
		expect(slot).toEqual(verdictBlocked);
	});

	test("a source rate limit still reaches a borrower slot without an auth block", () => {
		const source = { "anthropic-subscription": { type: "oauth", accounts: [
			{ name: "default", store: "claude-cli", dirId: "d1", blockReason: "rate_limit", blockedUntil: 999, blockedAt: 500 },
		] } };
		const borrower = { "anthropic-subscription": { type: "oauth", accounts: [{ name: "default", store: "claude-cli", dirId: "d1" }] } };
		const [slot] = borrowDocument(source, borrower).next["anthropic-subscription"].accounts;
		expect([slot.blockReason, slot.blockedUntil, slot.blockedAt]).toEqual(["rate_limit", 999, 500]);
	});

	test("a new login (new dirId) drops the borrower's state about the old one, keeping model blocks", () => {
		const borrower = { "anthropic-subscription": { type: "oauth", accounts: [verdictBlocked] } };
		const [slot] = borrowDocument(cliSource("d2"), borrower).next["anthropic-subscription"].accounts;
		expect(slot).toEqual({ name: "default", store: "claude-cli", dirId: "d2", modelBlocks: { m: 1 } });
	});
});

describe("connectionCheck", () => {
	test("only a clean JSON result counts as ok; timeout, error result, bad output and exit codes fail", () => {
		const at = 7;
		expect(connectionCheck({ exitCode: 0, stdout: '{"type":"result","is_error":false,"result":"OK"}' }, "m", at)).toEqual({ model: "m", outcome: "ok", at });
		expect(connectionCheck(undefined, "m", at).reason).toBe("timeout");
		expect(connectionCheck({ exitCode: 0, stdout: '{"type":"result","is_error":true}' }, "m", at).reason).toBe("no_result");
		expect(connectionCheck({ exitCode: 0, stdout: "OK" }, "m", at).reason).toBe("no_result");
		expect(connectionCheck({ exitCode: 1, stdout: "" }, "m", at).reason).toBe("exit_1");
		expect(connectionCheck({ exitCode: 0, stdout: '{"type":"result","is_error":false}' }, "m", at, "no_account").outcome).toBe("failed");
	});
});

describe("cliExpiresAt", () => {
	test("healthy, missing and malformed credential files each give a row, never a throw", () => {
		const files = { ok: '{"claudeAiOauth":{"expiresAt":5000}}', bad: "{not json" };
		const read = (slot) => {
			if (!(slot.dirId in files)) throw new Error("ENOENT: no such file");
			return JSON.parse(files[slot.dirId]);
		};
		expect(["ok", "missing", "bad"].map((dirId) => cliExpiresAt({ dirId }, read))).toEqual([5000, undefined, undefined]);
	});
});

describe("cliSnapshotsFrom", () => {
	test("a missing or expired Claude login is reported and skipped, the healthy one still travels", () => {
		const documents = {
			ok: { claudeAiOauth: { accessToken: "AT", refreshToken: "RT", expiresAt: 5000, scopes: ["user:inference"] } },
			old: { claudeAiOauth: { accessToken: "AT2", expiresAt: 10, scopes: ["user:inference"] } },
		};
		const slots = [
			{ name: "a", store: "claude-cli", dirId: "ok" },
			{ name: "b", store: "claude-cli", dirId: "missing" },
			{ name: "c", store: "claude-cli", dirId: "old" },
			{ name: "env", access: "X" },
		];
		const read = (slot) => {
			if (!documents[slot.dirId]) throw new Error("ENOENT: no such file");
			return documents[slot.dirId];
		};
		const { snapshots, failures } = cliSnapshotsFrom(slots, read, 1000);
		expect(snapshots.map((snapshot) => snapshot.dirId)).toEqual(["ok"]);
		expect(snapshots[0].credential.claudeAiOauth.refreshToken).toBeUndefined();
		expect(failures.map((failure) => failure.name)).toEqual(["b", "c"]);
	});
});

describe("borrowCliCredential", () => {
	const now = 1000;
	const oauth = { accessToken: "AT", refreshToken: "RT", expiresAt: 5000, scopes: ["user:inference"], subscriptionType: "max" };

	test("copies the access fields and never the refresh grant", () => {
		const { claudeAiOauth } = borrowCliCredential({ claudeAiOauth: oauth }, now);
		expect(claudeAiOauth).toEqual({ accessToken: "AT", expiresAt: 5000, scopes: ["user:inference"], subscriptionType: "max" });
	});

	test("refuses expired, placeholder or inference-less access", () => {
		for (const bad of [{ expiresAt: now }, { accessToken: PLACEHOLDER }, { scopes: ["user:profile"] }, { accessToken: "" }]) {
			expect(() => borrowCliCredential({ claudeAiOauth: { ...oauth, ...bad } }, now)).toThrow("Claude CLI access");
		}
	});
});
