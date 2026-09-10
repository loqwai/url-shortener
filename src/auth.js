/**
 * Write access is never open. A request may write only if it proves itself one of two ways:
 *
 *   1. Cloudflare Access - the `Cf-Access-Jwt-Assertion` header, verified against the team's
 *      public keys. This is the normal path for the browser UI.
 *   2. `UPLOAD_TOKEN` - an `X-Upload-Token` header matching the secret, for curl/scripts.
 *
 * If neither is configured, writes are refused rather than allowed: a misconfigured deploy
 * must not become an open file host.
 */

const certsCache = new Map();

const timingSafeEqual = (a, b) => {
	const encoder = new TextEncoder();
	const aBytes = encoder.encode(a);
	const bBytes = encoder.encode(b);
	if (aBytes.byteLength !== bBytes.byteLength) return false;
	return crypto.subtle.timingSafeEqual(aBytes, bBytes);
};

const base64UrlToBytes = (value) => {
	const base64 = value.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(value.length / 4) * 4, '=');
	const binary = atob(base64);
	return Uint8Array.from(binary, (char) => char.charCodeAt(0));
};

const decodeSegment = (segment) => JSON.parse(new TextDecoder().decode(base64UrlToBytes(segment)));

const fetchCerts = async (teamDomain) => {
	const cached = certsCache.get(teamDomain);
	if (cached && cached.expires > Date.now()) return cached.keys;

	const response = await fetch(`https://${teamDomain}/cdn-cgi/access/certs`);
	if (!response.ok) throw new Error(`Access certs fetch failed: ${response.status}`);
	const { keys } = await response.json();
	certsCache.set(teamDomain, { keys, expires: Date.now() + 60 * 60 * 1000 });
	return keys;
};

const verifyAccessJwt = async (token, teamDomain, audience) => {
	const [headerSegment, payloadSegment, signatureSegment] = token.split('.');
	if (!signatureSegment) return null;

	const header = decodeSegment(headerSegment);
	if (header.alg !== 'RS256') return null;

	const keys = await fetchCerts(teamDomain);
	const jwk = keys.find((key) => key.kid === header.kid);
	if (!jwk) return null;

	const publicKey = await crypto.subtle.importKey(
		'jwk',
		{ kty: jwk.kty, n: jwk.n, e: jwk.e, alg: 'RS256', ext: true },
		{ name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
		false,
		['verify']
	);

	const signed = new TextEncoder().encode(`${headerSegment}.${payloadSegment}`);
	const valid = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', publicKey, base64UrlToBytes(signatureSegment), signed);
	if (!valid) return null;

	const payload = decodeSegment(payloadSegment);
	const now = Math.floor(Date.now() / 1000);
	if (payload.exp && payload.exp < now) return null;
	if (payload.nbf && payload.nbf > now) return null;
	if (payload.iss !== `https://${teamDomain}`) return null;

	const audiences = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
	if (!audiences.includes(audience)) return null;

	return payload;
};

/**
 * @returns {Promise<{ ok: true, who: string } | { ok: false, status: number, error: string }>}
 */
export const authorizeWrite = async (request, env) => {
	const uploadToken = env.UPLOAD_TOKEN;
	const presentedToken = request.headers.get('X-Upload-Token');
	if (uploadToken && presentedToken && timingSafeEqual(presentedToken, uploadToken)) {
		return { ok: true, who: 'upload-token' };
	}

	const teamDomain = env.ACCESS_TEAM_DOMAIN;
	const audience = env.ACCESS_AUD;
	if (teamDomain && audience) {
		const assertion = request.headers.get('Cf-Access-Jwt-Assertion');
		if (assertion) {
			const payload = await verifyAccessJwt(assertion, teamDomain, audience).catch(() => null);
			if (payload) return { ok: true, who: payload.email || payload.sub || 'access' };
		}
		if (presentedToken || assertion) return { ok: false, status: 403, error: 'Not authorized to upload' };
		return { ok: false, status: 401, error: 'Sign in required' };
	}

	if (uploadToken) return { ok: false, status: 403, error: 'Not authorized to upload' };

	return {
		ok: false,
		status: 503,
		error: 'Uploads are disabled: set ACCESS_TEAM_DOMAIN + ACCESS_AUD, or an UPLOAD_TOKEN secret.',
	};
};
