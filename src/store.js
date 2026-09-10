/**
 * Records live in KV under their shortcode.
 *
 * Links created before file hosting existed are stored as a bare URL string, so `readRecord`
 * treats any non-JSON value as a legacy redirect. New records are JSON.
 *
 * The upload UI is itself a record (see ROOT_CODE), which is why this Worker needs no static
 * asset binding: serving the root and serving a hosted file are the same code path.
 */

const ALPHABET = 'abcdefghijklmnopqrstuvwxyz';
/** Generated codes read like an office number: xxx.xxx.xxxx, lowercase letters only. */
const CODE_GROUPS = [3, 3, 4];
const RESERVED = new Set(['api', 'up']);

/**
 * The UI is stored as ordinary content under this key, so the root is just another lookup.
 * CODE_PATTERN requires a leading alphanumeric, so no user-supplied code can ever reach it.
 */
export const ROOT_CODE = '_root';

/**
 * Cache policy is chosen per record. The default is permanent: files are meant to survive
 * in a device cache long after upload, including where there is no connectivity to
 * revalidate against. Codes are never reused, so a hosted file really is immutable.
 */
const CACHE_PRESETS = {
	permanent: 'public, max-age=31536000, immutable',
	week: 'public, max-age=604800',
	day: 'public, max-age=86400',
	hour: 'public, max-age=3600',
	revalidate: 'public, max-age=0, must-revalidate',
	none: 'no-store',
};

export const PERMANENT_CACHE = CACHE_PRESETS.permanent;

/** Accepts a preset name or a number of seconds. Unknown values fall back to permanent. */
export const cachePolicy = (choice) => {
	if (choice === undefined || choice === null || choice === '') return PERMANENT_CACHE;
	if (CACHE_PRESETS[choice]) return CACHE_PRESETS[choice];
	const seconds = Number(choice);
	if (Number.isInteger(seconds) && seconds >= 0) return seconds === 0 ? 'no-store' : `public, max-age=${seconds}`;
	return PERMANENT_CACHE;
};
const CODE_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/;

const randomLetters = (count) => {
	const letters = [];
	while (letters.length < count) {
		// Reject the tail of the byte range so every letter stays equally likely.
		const limit = Math.floor(256 / ALPHABET.length) * ALPHABET.length;
		for (const byte of crypto.getRandomValues(new Uint8Array(count))) {
			if (byte < limit && letters.length < count) letters.push(ALPHABET[byte % ALPHABET.length]);
		}
	}
	return letters.join('');
};

export const randomCode = () => CODE_GROUPS.map(randomLetters).join('.');

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
		const code = randomCode();
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
