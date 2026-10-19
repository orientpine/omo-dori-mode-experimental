// Pure document transform shared by the broker (oriclaw) and the remote side
// (each borrowing account). No I/O here: the remote script embeds this file.
//
// A borrowed provider entry is the source entry with every usable refresh
// token replaced by PLACEHOLDER, so a borrowing account can never redeem (and
// rotate) a single-use grant that the source owns. The borrower's own
// account-level state (rate-limit blocks, its pin) survives a push; an
// auth_error block is dropped once the slot carries a token it has not seen.

export const PLACEHOLDER = "omo-shared-login:managed-by-oriclaw";
const SENTINEL_REFRESH = new Set(["claude-sdk-oauth-managed"]);
const BLOCK_KEYS = ["blockedUntil", "blockReason", "modelBlocks", "authRecoveryGrant"];
const AUTH_ONLY_KEYS = ["authRecoveryGrant"];

function stripRefresh(value) {
	if (typeof value !== "string" || value === "" || SENTINEL_REFRESH.has(value)) return value;
	return PLACEHOLDER;
}

function borrowSlot(sourceSlot, borrowerSlot) {
	const slot = { ...sourceSlot };
	for (const key of BLOCK_KEYS) delete slot[key];
	if (slot.source !== "env") slot.refresh = stripRefresh(slot.refresh);
	if (!borrowerSlot) return slot;
	const sameToken = borrowerSlot.access === sourceSlot.access;
	const authBlocked = borrowerSlot.blockReason === "auth_error";
	if (sameToken) {
		for (const key of BLOCK_KEYS) if (borrowerSlot[key] !== undefined) slot[key] = borrowerSlot[key];
	} else if (!authBlocked) {
		// A rate limit belongs to the account, not to the token: keep it.
		for (const key of BLOCK_KEYS) {
			if (AUTH_ONLY_KEYS.includes(key)) continue;
			if (borrowerSlot[key] !== undefined) slot[key] = borrowerSlot[key];
		}
	} else if (borrowerSlot.modelBlocks !== undefined) {
		slot.modelBlocks = borrowerSlot.modelBlocks;
	}
	return slot;
}

export function borrowEntry(sourceEntry, borrowerEntry) {
	const entry = structuredClone(sourceEntry);
	for (const key of BLOCK_KEYS) delete entry[key];
	delete entry.pinned;
	entry.refresh = stripRefresh(entry.refresh);
	const borrower = borrowerEntry && typeof borrowerEntry === "object" ? borrowerEntry : undefined;
	if (Array.isArray(sourceEntry.accounts)) {
		const mine = Array.isArray(borrower?.accounts) ? borrower.accounts : [];
		entry.accounts = sourceEntry.accounts.map((slot) =>
			borrowSlot(slot, mine.find((candidate) => candidate.name === slot.name)),
		);
	} else if (borrower && borrower.access === sourceEntry.access) {
		for (const key of BLOCK_KEYS) if (borrower[key] !== undefined) entry[key] = borrower[key];
	}
	if (borrower?.pinned !== undefined) entry.pinned = borrower.pinned;
	return entry;
}

/**
 * Returns the borrower's next auth.json document: every OAuth provider of the
 * source is borrowed, OAuth providers the source no longer has are removed
 * (their grants live in the pre-share backup), and every non-OAuth entry of
 * the borrower (API keys) is left as it was.
 */
export function borrowDocument(source, borrower) {
	const next = {};
	const removed = [];
	for (const [providerId, entry] of Object.entries(borrower ?? {})) {
		if (entry?.type === "oauth" && !(source[providerId]?.type === "oauth")) {
			removed.push(providerId);
			continue;
		}
		next[providerId] = entry;
	}
	for (const [providerId, entry] of Object.entries(source)) {
		if (entry?.type !== "oauth") continue;
		next[providerId] = borrowEntry(entry, borrower?.[providerId]);
	}
	return { next, removed };
}

export function holdsNoGrant(document) {
	for (const entry of Object.values(document ?? {})) {
		if (entry?.type !== "oauth") continue;
		if (stripRefresh(entry.refresh) !== entry.refresh) return false;
		for (const slot of Array.isArray(entry.accounts) ? entry.accounts : []) {
			if (slot.source !== "env" && stripRefresh(slot.refresh) !== slot.refresh) return false;
		}
	}
	return true;
}
