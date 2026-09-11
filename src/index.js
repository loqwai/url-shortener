import { authorizeWrite } from './auth.js';
import {
	PERMANENT_CACHE,
	ROOT_CODE,
	cachePolicy,
	claimCode,
	deleteRecord,
	isValidCode,
	listRecords,
	readRecord,
	writeRecord,
} from './store.js';

/** Chunk size the browser uploads with. Must stay under the Workers request-body limit. */
const PART_SIZE = 64 * 1024 * 1024;
const INLINE_TYPES = /^(image\/|video\/|audio\/|text\/|application\/pdf$|application\/json$)/;

// API answers are per-caller and change as soon as anything is created or deleted, so they
// must not sit in a browser or proxy cache and be replayed.
const json = (body, status = 200) =>
	new Response(JSON.stringify(body), {
		status,
		headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
	});

const fail = (status, error) => json({ error }, status);

const shortUrl = (request, code) => `${new URL(request.url).origin}/${code}`;

/** Encode a filename for Content-Disposition, which cannot carry raw non-ASCII. */
const contentDisposition = (name, attachment) => {
	const safe = (name || 'file').replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '');
	const encoded = encodeURIComponent(name || 'file');
	return `${attachment ? 'attachment' : 'inline'}; filename="${safe}"; filename*=UTF-8''${encoded}`;
};

const serveFile = async (request, env, record) => {
	// R2 reports a `range` on every read taken from headers, so the request is the only
	// honest signal of whether the client actually asked for a partial response.
	const rangeRequested = request.headers.has('range');
	const object = await env.FILES.get(record.key, { range: request.headers, onlyIf: request.headers });
	if (!object) return fail(404, 'File is gone');

	const headers = new Headers();
	object.writeHttpMetadata(headers);
	headers.set('etag', object.httpEtag);
	headers.set('Cache-Control', record.cacheControl || PERMANENT_CACHE);
	headers.set('Accept-Ranges', 'bytes');
	if (record.contentType) headers.set('Content-Type', record.contentType);

	const wantsDownload = new URL(request.url).searchParams.has('dl');
	const inline = !wantsDownload && INLINE_TYPES.test(record.contentType || '');
	headers.set('Content-Disposition', contentDisposition(record.name, !inline));

	// `body` is absent when onlyIf turns the read into a 304.
	if (!('body' in object)) return new Response(null, { status: 304, headers });

	const body = request.method === 'HEAD' ? null : object.body;

	if (rangeRequested && object.range && 'offset' in object.range) {
		const start = object.range.offset ?? 0;
		const end = start + (object.range.length ?? object.size - start) - 1;
		headers.set('Content-Range', `bytes ${start}-${end}/${object.size}`);
		return new Response(body, { status: 206, headers });
	}

	return new Response(body, { headers });
};

const handleRead = async (request, env) => {
	const url = new URL(request.url);
	const code = decodeURIComponent(url.pathname.slice(1));

	// /up is a door for Cloudflare Access, which matches by path prefix: gating /up* prompts
	// a login and then lands here, while gating / would wall off every public short link.
	if (code === 'up') return Response.redirect(new URL('/', url).toString(), 302);

	// The root is the UI, stored as an ordinary record, so it takes the same path as any file.
	if (code !== '' && !isValidCode(code)) return fail(404, 'Not found');

	const record = await readRecord(env, code === '' ? ROOT_CODE : code);
	if (!record) return fail(404, 'Not found');
	if (record.type === 'pending') return fail(409, 'Still uploading');
	if (record.type === 'file') return serveFile(request, env, record);

	// A 301 is cached indefinitely by browsers whatever we say, so anything short of a
	// permanent policy has to go out as a 302 for the policy to mean anything.
	const policy = record.cacheControl || PERMANENT_CACHE;
	const permanent = policy === PERMANENT_CACHE;
	return new Response(null, {
		status: permanent ? 301 : 302,
		headers: { Location: record.url, 'Cache-Control': policy },
	});
};

const routes = {
	'POST /api/shorten': async (request, env) => {
		const { url, code: requested, cache } = await request.json();
		if (!url || !/^https?:\/\//i.test(url)) return fail(400, 'Provide an http(s) url');

		const { code, error } = await claimCode(env, requested);
		if (error) return fail(409, error);

		await writeRecord(env, code, {
			type: 'url',
			url,
			cacheControl: cachePolicy(cache),
			createdAt: new Date().toISOString(),
		});
		return json({ code, url: shortUrl(request, code) }, 201);
	},

	'POST /api/upload': async (request, env) => {
		const params = new URL(request.url).searchParams;
		const name = params.get('name') || 'file';
		const contentType = params.get('type') || 'application/octet-stream';

		// Publishing the UI overwrites one fixed record instead of claiming a new code, and
		// must revalidate rather than pin, since its URL never changes.
		const publishingUi = params.get('root') === '1';
		const cacheControl = publishingUi ? cachePolicy('revalidate') : cachePolicy(params.get('cache'));
		const { code, error } = publishingUi ? { code: ROOT_CODE } : await claimCode(env, params.get('code'));
		if (error) return fail(409, error);

		const key = publishingUi ? `${ROOT_CODE}/${name}` : `${code}/${name}`;
		const object = await env.FILES.put(key, request.body, { httpMetadata: { contentType } });

		await writeRecord(env, code, {
			type: 'file',
			key,
			name,
			size: object.size,
			contentType,
			cacheControl,
			createdAt: new Date().toISOString(),
		});
		return json({ code, url: shortUrl(request, code) }, 201);
	},

	'POST /api/multipart/create': async (request, env) => {
		const { name = 'file', type = 'application/octet-stream', code: requested, cache } = await request.json();
		const { code, error } = await claimCode(env, requested);
		if (error) return fail(409, error);

		const key = `${code}/${name}`;
		const upload = await env.FILES.createMultipartUpload(key, { httpMetadata: { contentType: type } });
		// Hold the code while the parts upload, so a second upload cannot claim it.
		await writeRecord(env, code, {
			type: 'pending',
			key,
			name,
			cacheControl: cachePolicy(cache),
			createdAt: new Date().toISOString(),
		});
		return json({ code, key, uploadId: upload.uploadId, partSize: PART_SIZE }, 201);
	},

	'PUT /api/multipart/part': async (request, env) => {
		const params = new URL(request.url).searchParams;
		const key = params.get('key');
		const uploadId = params.get('uploadId');
		const partNumber = Number(params.get('part'));
		if (!key || !uploadId || !Number.isInteger(partNumber) || partNumber < 1) return fail(400, 'Bad part request');

		const upload = env.FILES.resumeMultipartUpload(key, uploadId);
		const part = await upload.uploadPart(partNumber, request.body);
		return json(part);
	},

	'POST /api/multipart/complete': async (request, env) => {
		const { code, key, uploadId, parts, name, size, type, cache } = await request.json();
		if (!code || !key || !uploadId || !Array.isArray(parts)) return fail(400, 'Bad complete request');

		const upload = env.FILES.resumeMultipartUpload(key, uploadId);
		const object = await upload.complete(parts);

		await writeRecord(env, code, {
			type: 'file',
			key,
			name: name || 'file',
			size: object.size ?? size,
			contentType: type || 'application/octet-stream',
			cacheControl: cachePolicy(cache),
			createdAt: new Date().toISOString(),
		});
		return json({ code, url: shortUrl(request, code) }, 201);
	},

	'POST /api/multipart/abort': async (request, env) => {
		const { code, key, uploadId } = await request.json();
		if (key && uploadId) await env.FILES.resumeMultipartUpload(key, uploadId).abort();
		if (code) {
			const record = await readRecord(env, code);
			if (record && record.type === 'pending') await env.URL_MAP.delete(code);
		}
		return json({ ok: true });
	},

	'GET /api/list': async (request, env) => json({ items: await listRecords(env) }),

	'POST /api/delete': async (request, env) => {
		const { code } = await request.json();
		if (!code) return fail(400, 'Missing code');
		return json({ deleted: await deleteRecord(env, code) });
	},

	'GET /api/whoami': async (request, env, auth) => json({ who: auth.who, partSize: PART_SIZE }),
};

export default {
	async fetch(request, env) {
		const url = new URL(request.url);

		if (url.pathname.startsWith('/api/')) {
			const auth = await authorizeWrite(request, env);
			if (!auth.ok) return fail(auth.status, auth.error);

			const route = routes[`${request.method} ${url.pathname}`];
			if (!route) return fail(404, 'No such endpoint');
			return route(request, env, auth);
		}

		if (request.method === 'GET' || request.method === 'HEAD') return handleRead(request, env);

		// The original API shape, kept working: POST /<code> with {"url": "..."} claims that code.
		if (request.method === 'POST') {
			const auth = await authorizeWrite(request, env);
			if (!auth.ok) return fail(auth.status, auth.error);

			const code = url.pathname.slice(1);
			if (!isValidCode(code)) return fail(400, 'Invalid short code');
			if (await env.URL_MAP.get(code)) return fail(400, 'Short code already exists');

			const { url: target } = await request.json();
			if (!target) return fail(400, 'Missing url');
			await writeRecord(env, code, { type: 'url', url: target, createdAt: new Date().toISOString() });
			return json({ url: shortUrl(request, code) }, 201);
		}

		return fail(405, 'Method not allowed');
	},
};
