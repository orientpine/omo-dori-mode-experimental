import { afterEach, expect, test } from "bun:test";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { borrowCliCredential } from "./borrow.js";

const globalModules = join(homedir(), ".bun/install/global/node_modules");
const cli = await import(join(globalModules, "@code-yeongyu/senpi/dist/core/extensions/builtin/anthropic-subscription/claude-cli-account-dir.js"));
const id = "1234567890abcdef1234567890abcdef";
const roots = [];
afterEach(() => {
	for (const root of roots.splice(0)) {
		rmSync(root, { recursive: true, force: true });
		expect(existsSync(root)).toBe(false);
	}
});

function fixture() {
	const root = mkdtempSync(join(tmpdir(), "share-cli-"));
	roots.push(root);
	mkdirSync(join(root, ".bun/install/global"), { recursive: true });
	symlinkSync(globalModules, join(root, ".bun/install/global/node_modules"));
	const agentDir = join(root, "agent");
	mkdirSync(agentDir, { mode: 0o700 });
	writeFileSync(join(agentDir, "auth.json"), "{}", { mode: 0o600 });
	return { root, agentDir };
}
const credential = (accessToken = "access-one") => ({
	claudeAiOauth: { accessToken, refreshToken: "owner-grant", refreshTokenExpiresAt: 9999999999999,
		expiresAt: Date.now() + 3600000, scopes: ["user:inference"], subscriptionType: "max" },
	privateData: "must-not-travel",
});
const source = {
	"anthropic-subscription": {
		type: "oauth", access: "claude-sdk-oauth-managed", refresh: "claude-sdk-oauth-managed", expires: 4102444800000,
		accounts: [{ name: "default", source: "login", store: "claude-cli", dirId: id,
			blockReason: "rate_limit", blockedUntil: 4102444800000 }],
	},
};
async function remote(f, action, snapshots = []) {
	const child = Bun.spawn([process.execPath, join(import.meta.dir, "remote.js")], {
		env: { ...process.env, HOME: f.root }, stdin: "pipe", stdout: "pipe", stderr: "pipe",
	});
	child.stdin.write(JSON.stringify({ action, agentDir: f.agentDir, source, cliSnapshots: snapshots, stamp: "test" }));
	child.stdin.end();
	const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
	return { exit, stderr, stdout, value: exit === 0 ? JSON.parse(stdout) : undefined };
}

test("remote push rotates access atomically for the installed reader and never stores refresh authority", async () => {
	const f = fixture();
	const first = await remote(f, "push", [{ dirId: id, credential: credential() }]);
	expect(first.exit).toBe(0);
	const directory = cli.accountDirFor(f.agentDir, id);
	expect(await cli.readClaudeCliAccessToken(directory, Date.now())).toBe("access-one");
	const second = await remote(f, "push", [{ dirId: id, credential: credential("access-two") }]);
	expect(second.exit).toBe(0);
	expect(await cli.readClaudeCliAccessToken(directory, Date.now())).toBe("access-two");
	const stored = JSON.parse(readFileSync(join(directory, ".credentials.json"), "utf8"));
	expect(stored.claudeAiOauth.refreshToken).toBeUndefined();
	expect(stored.claudeAiOauth.refreshTokenExpiresAt).toBeUndefined();
	expect(stored.privateData).toBeUndefined();
	expect(lstatSync(directory).mode & 0o777).toBe(0o700);
	expect(lstatSync(join(directory, ".credentials.json")).mode & 0o777).toBe(0o600);
	expect(second.value.holdsNoGrant).toBe(true);
	expect(second.stdout.includes("access-two")).toBe(false);
	expect(second.stdout.includes("owner-grant")).toBe(false);
	expect(JSON.parse(readFileSync(join(f.agentDir, "auth.json"), "utf8"))["anthropic-subscription"].accounts[0].blockReason).toBe("rate_limit");
});

test.each(["expired", "sentinel", "no-inference"])("refuses %s access before altering borrower auth", async (kind) => {
	const f = fixture();
	const material = credential();
	if (kind === "expired") material.claudeAiOauth.expiresAt = Date.now() - 1;
	if (kind === "sentinel") material.claudeAiOauth.accessToken = "claude-sdk-oauth-managed";
	if (kind === "no-inference") material.claudeAiOauth.scopes = ["user:profile"];
	const result = await remote(f, "push", [{ dirId: id, credential: material }]);
	expect(result.exit).not.toBe(0);
	expect(readFileSync(join(f.agentDir, "auth.json"), "utf8")).toBe("{}");
});

test("status rejects expired access and a linked credential file", async () => {
	const f = fixture();
	expect((await remote(f, "push", [{ dirId: id, credential: credential() }])).exit).toBe(0);
	const directory = cli.accountDirFor(f.agentDir, id);
	const path = join(directory, ".credentials.json");
	const expired = borrowCliCredential(credential(), Date.now());
	expired.claudeAiOauth.expiresAt = 1;
	writeFileSync(path, JSON.stringify(expired));
	expect((await remote(f, "status")).value.state["anthropic-subscription"].slots[0].usable).toBe(false);
	expect(await cli.readClaudeCliAccessToken(directory, Date.now())).toBeUndefined();
	rmSync(path);
	symlinkSync(join(f.agentDir, "auth.json"), path);
	expect((await remote(f, "push", [{ dirId: id, credential: credential() }])).exit).not.toBe(0);
});

test("refuses to overwrite an independently owned borrower grant", async () => {
	const f = fixture();
	const directory = cli.accountDirFor(f.agentDir, id);
	mkdirSync(directory, { recursive: true, mode: 0o700 });
	const original = JSON.stringify(credential("borrower-access"));
	writeFileSync(join(directory, ".credentials.json"), original, { mode: 0o600 });
	const result = await remote(f, "push", [{ dirId: id, credential: credential() }]);
	expect(result.exit).not.toBe(0);
	expect(readFileSync(join(directory, ".credentials.json"), "utf8")).toBe(original);
	expect(readFileSync(join(f.agentDir, "auth.json"), "utf8")).toBe("{}");
});

test("rollback restores the original auth and removes only its marked access-only directory", async () => {
	const f = fixture();
	expect((await remote(f, "push", [{ dirId: id, credential: credential() }])).exit).toBe(0);
	const result = await remote(f, "restore");
	expect(result.exit).toBe(0);
	expect(result.value.identical).toBe(true);
	expect(readFileSync(join(f.agentDir, "auth.json"), "utf8")).toBe("{}");
	expect(existsSync(cli.accountDirFor(f.agentDir, id))).toBe(false);
});
