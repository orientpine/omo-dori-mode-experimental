// Runs as a borrowing account (sudo -n -u <account> bun -e <this file + borrow.js>).
// Credentials arrive on stdin only; stdout carries digests and expiry times, never a token.
import { createHash } from "node:crypto";
import { chmodSync, existsSync, lstatSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { borrowCliCredential, borrowDocument, holdsNoGrant, PLACEHOLDER } from "./borrow.js";

const BACKUP_PREFIX = "auth.json.before-shared-login-";
const input = globalThis.__OLS_INPUT ?? JSON.parse(await Bun.stdin.text());
const home = homedir();
const agentDir = resolve(input.agentDir ?? join(home, ".omo", "agent"));
if (!agentDir.startsWith(`${home}/`)) throw new Error(`agent dir ${agentDir} is outside ${home}`);
const authPath = join(agentDir, "auth.json");
const { FileAuthStorageBackend } = await import(
	join(home, ".bun/install/global/node_modules/@code-yeongyu/senpi/dist/core/auth-storage.js")
);
const backend = new FileAuthStorageBackend(authPath);
const cli = await import(join(home, ".bun/install/global/node_modules/@code-yeongyu/senpi/dist/core/extensions/builtin/anthropic-subscription/claude-cli-account-dir.js"));

function cliState(slot) {
	if (slot.store !== "claude-cli") return {};
	const directory = cli.accountDirFor(agentDir, slot.dirId);
	const path = join(directory, ".credentials.json");
	try {
		const dir = lstatSync(directory);
		const file = lstatSync(path);
		if (!dir.isDirectory() || !file.isFile()) return { usable: false, noGrant: false };
		const document = JSON.parse(readFileSync(path, "utf8"));
		const oauth = document.claudeAiOauth;
		let usable = false;
		try { borrowCliCredential(document, Date.now()); usable = true; } catch { /* Invalid credentials are reported, not accepted. */ }
		return {
			access: digest(oauth?.accessToken), expires: oauth?.expiresAt,
			refresh: oauth?.refreshToken ? "grant" : "none",
			noGrant: !oauth?.refreshToken && !oauth?.refreshTokenExpiresAt,
			usable: usable && (dir.mode & 0o777) === 0o700 && (file.mode & 0o777) === 0o600,
		};
	} catch {
		return { usable: false, noGrant: false };
	}
}

function writeCliSnapshots(snapshots) {
	const root = join(agentDir, "anthropic-subscription-claude");
	if (existsSync(root) && !lstatSync(root).isDirectory()) throw new Error("CLI root must be a real directory");
	for (const snapshot of snapshots ?? []) {
		const directory = cli.accountDirFor(agentDir, snapshot.dirId);
		if (existsSync(directory) && !lstatSync(directory).isDirectory()) throw new Error("CLI account must be a real directory");
		const credential = borrowCliCredential(snapshot.credential, Date.now());
		cli.ensureAccountDir({ agentDir, dirId: snapshot.dirId, sharedRoot: join(home, ".claude") });
		const path = join(directory, ".credentials.json");
		if (existsSync(path) && !lstatSync(path).isFile()) throw new Error("CLI credentials must be a real file");
		if (existsSync(path) && JSON.parse(readFileSync(path, "utf8")).claudeAiOauth?.refreshToken) {
			throw new Error("Refusing to replace a borrower-owned Claude refresh grant");
		}
		writeFileSync(join(directory, ".omo-shared-login"), "access-only\n", { mode: 0o600 });
		const text = JSON.stringify(credential);
		if (existsSync(path) && readFileSync(path, "utf8") === text) {
			chmodSync(path, 0o600);
			continue;
		}
		const temporary = `${path}.share-${process.pid}`;
		try {
			writeFileSync(temporary, text, { mode: 0o600, flag: "wx" });
			renameSync(temporary, path);
		} finally {
			rmSync(temporary, { force: true });
		}
	}
}

const digest = (value) =>
	typeof value === "string" && value !== "" ? createHash("sha256").update(value).digest("hex").slice(0, 8) : null;
const refreshKind = (value) =>
	value === PLACEHOLDER ? "placeholder" : value === "claude-sdk-oauth-managed" ? "sentinel" : value ? "grant" : "empty";

function describe(document) {
	const providers = {};
	for (const [providerId, entry] of Object.entries(document ?? {})) {
		if (entry?.type !== "oauth") {
			providers[providerId] = { type: entry?.type };
			continue;
		}
		const slots = Array.isArray(entry.accounts) ? entry.accounts : [{ name: "(flat)", ...entry }];
		providers[providerId] = {
			type: "oauth",
			slots: slots.map((slot) => ({
				name: slot.name,
				access: digest(slot.access),
				refresh: refreshKind(slot.refresh),
				expires: slot.expires,
				blockReason: slot.blockReason ?? null,
				store: slot.store,
				dirId: slot.dirId,
				...cliState(slot),
			})),
		};
	}
	return providers;
}

const backups = () =>
	existsSync(agentDir)
		? readdirSync(agentDir)
				.filter((name) => name.startsWith(BACKUP_PREFIX) && !name.includes(".restored-"))
				.sort()
		: [];
const readDocument = () => (existsSync(authPath) ? JSON.parse(readFileSync(authPath, "utf-8")) : {});
const fileDigest = (path) => createHash("sha256").update(readFileSync(path)).digest("hex").slice(0, 16);

let result;
if (input.action === "push") {
	result = await backend.withLockAsync(async (current) => {
		let backup = backups()[0];
		if (!backup && current !== undefined) {
			backup = `${BACKUP_PREFIX}${input.stamp}`;
			writeFileSync(join(agentDir, backup), current, { encoding: "utf-8", mode: 0o600 });
		}
		const { next, removed } = borrowDocument(input.source, current ? JSON.parse(current) : {});
		writeCliSnapshots(input.cliSnapshots);
		const text = JSON.stringify(next, null, 2);
		if (text === current) return { result: { changed: false, backup, removed } };
		return { result: { changed: true, backup, removed }, next: text };
	});
	const after = readDocument();
	result = { ...result, holdsNoGrant: holdsNoGrant(after) && (after["anthropic-subscription"]?.accounts ?? []).every((slot) => slot.store !== "claude-cli" || cliState(slot).noGrant), state: describe(after) };
} else if (input.action === "status") {
	const document = readDocument();
	result = { holdsNoGrant: holdsNoGrant(document) && (document["anthropic-subscription"]?.accounts ?? []).every((slot) => slot.store !== "claude-cli" || cliState(slot).noGrant), backups: backups(), state: describe(document) };
} else if (input.action === "restore") {
	const backup = backups()[0];
	if (!backup) {
		result = { restored: false, reason: "no backup" };
	} else {
		const backupPath = join(agentDir, backup);
		const before = readDocument();
		await backend.withLockAsync(async () => ({ result: undefined, next: readFileSync(backupPath, "utf-8") }));
		const identical = fileDigest(backupPath) === fileDigest(authPath);
		renameSync(backupPath, `${backupPath}.restored-${input.stamp}`);
		for (const slot of before["anthropic-subscription"]?.accounts ?? []) {
			if (slot.store !== "claude-cli") continue;
			const directory = cli.accountDirFor(agentDir, slot.dirId);
			if (existsSync(directory) && lstatSync(directory).isDirectory() && existsSync(join(directory, ".omo-shared-login")) && cliState(slot).noGrant) {
				rmSync(directory, { recursive: true });
			}
		}
		result = { restored: true, backup, identical, state: describe(readDocument()) };
	}
} else {
	throw new Error(`unknown action ${input.action}`);
}
process.stdout.write(`${JSON.stringify({ ok: true, account: process.env.USER ?? null, agentDir, ...result })}\n`);
