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
// A Claude CLI slot's verdict state: senpi drops an auth_error block whose
// authVerdict does not match its dirId and blockedAt (isForeignAuthBlock), so
// these travel together, and only while the slot still names the same login.
const CLI_STATE_KEYS = [...BLOCK_KEYS, "blockedAt", "authVerdict", "signInRequired"];

function stripRefresh(value) {
	if (typeof value !== "string" || value === "" || SENTINEL_REFRESH.has(value)) return value;
	return PLACEHOLDER;
}

function borrowSlot(sourceSlot, borrowerSlot) {
	const slot = { ...sourceSlot };
	for (const key of BLOCK_KEYS) delete slot[key];
	if (sourceSlot.store === "claude-cli") {
		delete slot.access;
		delete slot.refresh;
		delete slot.expires;
		for (const key of CLI_STATE_KEYS) delete slot[key];
		// CLI slots hold identity, not tokens. A missing access field cannot prove
		// a new login, so leave auth recovery to senpi's CLI verdict. A new dirId
		// is a new login: the borrower's state about the old one does not carry.
		const sameLogin = borrowerSlot?.store === "claude-cli" && borrowerSlot.dirId === sourceSlot.dirId;
		for (const key of sameLogin ? CLI_STATE_KEYS : ["modelBlocks"]) {
			if (borrowerSlot?.[key] !== undefined) slot[key] = borrowerSlot[key];
		}
		if (sourceSlot.blockReason === "rate_limit" &&
			(sourceSlot.blockedUntil ?? 0) > (slot.blockedUntil ?? 0)) {
			slot.blockReason = "rate_limit";
			slot.blockedUntil = sourceSlot.blockedUntil;
			slot.blockedAt = sourceSlot.blockedAt;
		}
		return slot;
	}
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

// The access-only copies of the source's Claude CLI slots. One missing or
// expired login is reported and skipped; the other slots still travel.
// readDocument(slot) returns the slot's parsed .credentials.json or throws.
export function cliSnapshotsFrom(slots, readDocument, now) {
	const snapshots = [];
	const failures = [];
	for (const slot of slots ?? []) {
		if (slot?.store !== "claude-cli") continue;
		try {
			snapshots.push({ dirId: slot.dirId, credential: borrowCliCredential(readDocument(slot), now) });
		} catch (error) {
			failures.push({ name: slot.name, message: String(error?.message ?? error).split("\n")[0].slice(0, 160) });
		}
	}
	return { snapshots, failures };
}

// Only these access-related fields travel. Never copy an entire CLI directory
// or credential object: it also holds the owner's rotating refresh authority.
export function borrowCliCredential(document, now) {
	const oauth = document?.claudeAiOauth;
	if (typeof oauth?.accessToken !== "string" || !oauth.accessToken ||
		oauth.accessToken === PLACEHOLDER || SENTINEL_REFRESH.has(oauth.accessToken) ||
		typeof oauth.expiresAt !== "number" || !Number.isFinite(oauth.expiresAt) || oauth.expiresAt <= now ||
		!Array.isArray(oauth.scopes) || !oauth.scopes.includes("user:inference")) {
		throw new Error("Claude CLI access is missing, malformed or expired");
	}
	return {
		claudeAiOauth: {
			accessToken: oauth.accessToken,
			expiresAt: oauth.expiresAt,
			scopes: oauth.scopes.filter((scope) => typeof scope === "string"),
			...(typeof oauth.subscriptionType === "string" ? { subscriptionType: oauth.subscriptionType } : {}),
			...(typeof oauth.rateLimitTier === "string" ? { rateLimitTier: oauth.rateLimitTier } : {}),
		},
	};
}
