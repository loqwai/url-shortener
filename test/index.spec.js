import { env, SELF } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';

const AUTH = { 'X-Upload-Token': 'test-token' };

// Storage isolation is off (see vitest.config.js), so each test starts from a clean slate here.
beforeEach(async () => {
	const { keys } = await env.URL_MAP.list();
	await Promise.all(keys.map(({ name }) => env.URL_MAP.delete(name)));
	const { objects } = await env.FILES.list();
	await Promise.all(objects.map(({ key }) => env.FILES.delete(key)));
});

describe('reading', () => {
	it('serves the published UI at the root', async () => {
		await SELF.fetch('https://2cb.pw/api/upload?root=1&name=index.html&type=text/html', {
			method: 'POST',
			headers: AUTH,
			body: '<h1>Drop files here</h1><button>Shorten</button>',
		});

		const response = await SELF.fetch('https://2cb.pw/');
		expect(response.status).toBe(200);
		expect(await response.text()).toContain('Drop files here');
		expect(response.headers.get('content-type')).toContain('text/html');
	});

	it('lets the root UI revalidate instead of pinning it forever', async () => {
		await SELF.fetch('https://2cb.pw/api/upload?root=1&name=index.html&type=text/html', {
			method: 'POST',
			headers: AUTH,
			body: '<h1>first</h1>',
		});
		const response = await SELF.fetch('https://2cb.pw/');
		expect(response.headers.get('cache-control')).toBe('public, max-age=0, must-revalidate');

		// Republishing must actually replace what the root serves.
		await SELF.fetch('https://2cb.pw/api/upload?root=1&name=index.html&type=text/html', {
			method: 'POST',
			headers: AUTH,
			body: '<h1>second</h1>',
		});
		expect(await (await SELF.fetch('https://2cb.pw/')).text()).toContain('second');
	});

	it('404s the root when no UI has been published', async () => {
		const response = await SELF.fetch('https://2cb.pw/');
		expect(response.status).toBe(404);
	});

	it('keeps uploads pinned immutably', async () => {
		await SELF.fetch('https://2cb.pw/api/upload?name=a.txt&type=text/plain&code=cc1', {
			method: 'POST',
			headers: AUTH,
			body: 'x',
		});
		const response = await SELF.fetch('https://2cb.pw/cc1');
		expect(response.headers.get('cache-control')).toContain('immutable');
	});

	it('sends /up, the Access door, to the UI', async () => {
		const response = await SELF.fetch('https://2cb.pw/up', { redirect: 'manual' });
		expect(response.status).toBe(302);
		expect(response.headers.get('location')).toBe('https://2cb.pw/');
	});

	it('redirects a short code to its target', async () => {
		await env.URL_MAP.put('abc', JSON.stringify({ type: 'url', url: 'https://example.com/target' }));
		const response = await SELF.fetch('https://2cb.pw/abc', { redirect: 'manual' });
		expect(response.status).toBe(301);
		expect(response.headers.get('location')).toBe('https://example.com/target');
	});

	it('still redirects links stored in the old bare-string format', async () => {
		await env.URL_MAP.put('legacy', 'https://example.com/old');
		const response = await SELF.fetch('https://2cb.pw/legacy', { redirect: 'manual' });
		expect(response.status).toBe(301);
		expect(response.headers.get('location')).toBe('https://example.com/old');
	});

	it('404s an unknown code', async () => {
		const response = await SELF.fetch('https://2cb.pw/nope');
		expect(response.status).toBe(404);
	});
});

describe('shortening', () => {
	it('creates a code and returns the short url', async () => {
		const response = await SELF.fetch('https://2cb.pw/api/shorten', {
			method: 'POST',
			headers: { ...AUTH, 'Content-Type': 'application/json' },
			body: JSON.stringify({ url: 'https://example.com/long', code: 'mine' }),
		});
		expect(response.status).toBe(201);
		expect(await response.json()).toEqual({ code: 'mine', url: 'https://2cb.pw/mine' });
	});

	it('generates a code when none is given', async () => {
		const response = await SELF.fetch('https://2cb.pw/api/shorten', {
			method: 'POST',
			headers: { ...AUTH, 'Content-Type': 'application/json' },
			body: JSON.stringify({ url: 'https://example.com/long' }),
		});
		const { code } = await response.json();
		expect(code).toMatch(/^[a-zA-Z0-9]{6}$/);
	});

	it('refuses a code that is already taken', async () => {
		await env.URL_MAP.put('taken', 'https://example.com/first');
		const response = await SELF.fetch('https://2cb.pw/api/shorten', {
			method: 'POST',
			headers: { ...AUTH, 'Content-Type': 'application/json' },
			body: JSON.stringify({ url: 'https://example.com/second', code: 'taken' }),
		});
		expect(response.status).toBe(409);
	});

	it('rejects a non-http target', async () => {
		const response = await SELF.fetch('https://2cb.pw/api/shorten', {
			method: 'POST',
			headers: { ...AUTH, 'Content-Type': 'application/json' },
			body: JSON.stringify({ url: 'javascript:alert(1)' }),
		});
		expect(response.status).toBe(400);
	});
});

describe('file hosting', () => {
	const uploadText = (body, { name = 'hello.txt', type = 'text/plain', code } = {}) => {
		const query = new URLSearchParams({ name, type });
		if (code) query.set('code', code);
		return SELF.fetch(`https://2cb.pw/api/upload?${query}`, { method: 'POST', headers: AUTH, body });
	};

	it('stores an uploaded file and serves it back', async () => {
		const created = await uploadText('hello world', { code: 'f1' });
		expect(created.status).toBe(201);

		const served = await SELF.fetch('https://2cb.pw/f1');
		expect(served.status).toBe(200);
		expect(await served.text()).toBe('hello world');
		expect(served.headers.get('content-type')).toContain('text/plain');
		expect(served.headers.get('content-disposition')).toContain('inline');
	});

	it('forces a download when asked', async () => {
		await uploadText('hello world', { code: 'f2' });
		const served = await SELF.fetch('https://2cb.pw/f2?dl');
		expect(served.headers.get('content-disposition')).toContain('attachment');
	});

	it('sends a binary file as an attachment', async () => {
		await uploadText('data', { name: 'thing.bin', type: 'application/octet-stream', code: 'f3' });
		const served = await SELF.fetch('https://2cb.pw/f3');
		expect(served.headers.get('content-disposition')).toContain('attachment');
		expect(served.headers.get('content-disposition')).toContain('thing.bin');
	});

	it('serves a byte range', async () => {
		await uploadText('0123456789', { code: 'f4' });
		const served = await SELF.fetch('https://2cb.pw/f4', { headers: { Range: 'bytes=2-4' } });
		expect(served.status).toBe(206);
		expect(await served.text()).toBe('234');
		expect(served.headers.get('content-range')).toBe('bytes 2-4/10');
	});

	it('deletes the file along with the code', async () => {
		await uploadText('bye', { code: 'f5' });
		const response = await SELF.fetch('https://2cb.pw/api/delete', {
			method: 'POST',
			headers: { ...AUTH, 'Content-Type': 'application/json' },
			body: JSON.stringify({ code: 'f5' }),
		});
		expect(await response.json()).toEqual({ deleted: true });
		expect(await SELF.fetch('https://2cb.pw/f5')).toMatchObject({ status: 404 });
	});

	it('uploads a large file in parts', async () => {
		const created = await SELF.fetch('https://2cb.pw/api/multipart/create', {
			method: 'POST',
			headers: { ...AUTH, 'Content-Type': 'application/json' },
			body: JSON.stringify({ name: 'big.bin', type: 'application/octet-stream', code: 'big' }),
		});
		const { code, key, uploadId } = await created.json();

		// A held code is not yet readable, so a second upload cannot steal it.
		expect(await SELF.fetch('https://2cb.pw/big')).toMatchObject({ status: 409 });

		const chunks = ['a'.repeat(6 * 1024 * 1024), 'b'.repeat(16)];
		const parts = [];
		for (const [index, chunk] of chunks.entries()) {
			const query = new URLSearchParams({ key, uploadId, part: String(index + 1) });
			const response = await SELF.fetch(`https://2cb.pw/api/multipart/part?${query}`, {
				method: 'PUT',
				headers: AUTH,
				body: chunk,
			});
			expect(response.status).toBe(200);
			parts.push(await response.json());
		}

		const completed = await SELF.fetch('https://2cb.pw/api/multipart/complete', {
			method: 'POST',
			headers: { ...AUTH, 'Content-Type': 'application/json' },
			body: JSON.stringify({ code, key, uploadId, name: 'big.bin', type: 'application/octet-stream', parts }),
		});
		expect(completed.status).toBe(201);

		const served = await SELF.fetch('https://2cb.pw/big', { headers: { Range: 'bytes=0-3' } });
		expect(await served.text()).toBe('aaaa');
	});
});

describe('authorization', () => {
	it('refuses an upload with no credentials', async () => {
		const response = await SELF.fetch('https://2cb.pw/api/upload?name=x.txt', { method: 'POST', body: 'x' });
		expect(response.status).toBe(403);
	});

	it('refuses an upload with the wrong token', async () => {
		const response = await SELF.fetch('https://2cb.pw/api/upload?name=x.txt', {
			method: 'POST',
			headers: { 'X-Upload-Token': 'wrong' },
			body: 'x',
		});
		expect(response.status).toBe(403);
	});

	it('leaves reads public', async () => {
		await env.URL_MAP.put('open', 'https://example.com/open');
		const response = await SELF.fetch('https://2cb.pw/open', { redirect: 'manual' });
		expect(response.status).toBe(301);
	});
});
