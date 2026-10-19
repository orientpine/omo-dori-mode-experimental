// Runs as a borrowing account (sudo -n -u <account> bun -e <this file + borrow.js>).
// Credentials arrive on stdin only; stdout carries digests and expiry times, never a token.
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { borrowDocument, holdsNoGrant, PLACEHOLDER } from "./borrow.js";

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
		const text = JSON.stringify(next, null, 2);
		if (text === current) return { result: { changed: false, backup, removed } };
		return { result: { changed: true, backup, removed }, next: text };
	});
	const after = readDocument();
	result = { ...result, holdsNoGrant: holdsNoGrant(after), state: describe(after) };
} else if (input.action === "status") {
	const document = readDocument();
	result = { holdsNoGrant: holdsNoGrant(document), backups: backups(), state: describe(document) };
} else if (input.action === "restore") {
	const backup = backups()[0];
	if (!backup) {
		result = { restored: false, reason: "no backup" };
	} else {
		const backupPath = join(agentDir, backup);
		await backend.withLockAsync(async () => ({ result: undefined, next: readFileSync(backupPath, "utf-8") }));
		const identical = fileDigest(backupPath) === fileDigest(authPath);
		renameSync(backupPath, `${backupPath}.restored-${input.stamp}`);
		result = { restored: true, backup, identical, state: describe(readDocument()) };
	}
} else {
	throw new Error(`unknown action ${input.action}`);
}
process.stdout.write(`${JSON.stringify({ ok: true, account: process.env.USER ?? null, agentDir, ...result })}\n`);
