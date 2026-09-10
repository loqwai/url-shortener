/**
 * Records live in KV under their shortcode.
 *
 * Links created before file hosting existed are stored as a bare URL string, so `readRecord`
 * treats any non-JSON value as a legacy redirect. New records are JSON.
 */

const ALPHABET = 'abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const RESERVED = new Set(['api', 'index.html', 'favicon.ico', 'robots.txt', 'up', 'admin']);
const CODE_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/;

export const randomCode = (length = 6) => {
	const bytes = crypto.getRandomValues(new Uint8Array(length));
	return Array.from(bytes, (byte) => ALPHABET[byte % ALPHABET.length]).join('');
};

export const isValidCode = (code) => typeof code === 'string' && CODE_PATTERN.test(code) && !RESERVED.has(code.toLowerCase());

export const readRecord = async (env, code) => {
	const raw = await env.URL_MAP.get(code);
	if (raw === null) return null;
	if (!raw.startsWith('{')) return { type: 'url', url: raw };
	try {
		return JSON.parse(raw);
	} catch {
		return { type: 'url', url: raw };
	}
};

export const writeRecord = (env, code, record) =>
	env.URL_MAP.put(code, JSON.stringify(record), {
		metadata: { type: record.type, name: record.name, size: record.size, createdAt: record.createdAt },
	});

/** Reserve a code so two concurrent uploads cannot claim the same one. */
export const claimCode = async (env, requested) => {
	if (requested) {
		if (!isValidCode(requested)) return { error: 'Invalid short code' };
		if (await env.URL_MAP.get(requested)) return { error: 'That short code is taken' };
		return { code: requested };
	}

	for (let attempt = 0; attempt < 5; attempt += 1) {
		const code = randomCode(attempt < 3 ? 6 : 8);
		if (!(await env.URL_MAP.get(code))) return { code };
	}
	return { error: 'Could not allocate a short code, try again' };
};

export const deleteRecord = async (env, code) => {
	const record = await readRecord(env, code);
	if (!record) return false;
	if (record.type === 'file' && record.key) await env.FILES.delete(record.key);
	await env.URL_MAP.delete(code);
	return true;
};

export const listRecords = async (env, limit = 50) => {
	const { keys } = await env.URL_MAP.list({ limit });
	return keys
		.map(({ name, metadata }) => ({ code: name, ...(metadata || {}) }))
		.sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
};
