/**
 * Publishes public/index.html as the record served at the root.
 *
 * This runs as part of `npm run deploy` on purpose. The UI is content now, not a bundled
 * asset, so a Worker deploy alone would leave the live page on an older build and let the
 * repo drift away from what is actually served.
 */
import { readFile } from 'node:fs/promises';

const origin = process.env.SHORTENER_ORIGIN || 'https://2cb.pw';
const key = process.env.UPLOAD_KEY;

if (!key) {
	console.error('UPLOAD_KEY is not set, so the UI was not published.');
	console.error('Set it to the Worker\'s UPLOAD_TOKEN secret, or publish by hand with:');
	console.error(`  curl -X POST -H "X-Upload-Token: $UPLOAD_KEY" --data-binary @public/index.html \\`);
	console.error(`    "${origin}/api/upload?root=1&name=index.html&type=text/html"`);
	process.exit(1);
}

const ROOT_CODE = '_root';
const body = await readFile(new URL('../public/index.html', import.meta.url));
const query = new URLSearchParams({ root: '1', name: 'index.html', type: 'text/html; charset=utf-8' });
const auth = { 'X-Upload-Token': key };

/**
 * A Worker deploy takes a few seconds to propagate, and a version that predates `root=1`
 * ignores it and cheerfully files the UI under a random code instead - a 201 that did the
 * wrong thing. So insist on the code coming back as ROOT_CODE, and clean up any stray.
 */
for (let attempt = 1; attempt <= 5; attempt += 1) {
	const response = await fetch(`${origin}/api/upload?${query}`, { method: 'POST', headers: auth, body });
	const result = await response.json().catch(() => ({}));

	if (response.ok && result.code === ROOT_CODE) {
		console.log(`Published public/index.html to ${origin}/ (${body.byteLength} bytes)`);
		process.exit(0);
	}

	if (response.ok && result.code) {
		console.error(`Attempt ${attempt}: an older Worker filed the UI as "${result.code}". Removing it.`);
		await fetch(`${origin}/api/delete`, {
			method: 'POST',
			headers: { ...auth, 'Content-Type': 'application/json' },
			body: JSON.stringify({ code: result.code }),
		}).catch(() => {});
	} else {
		console.error(`Attempt ${attempt}: ${response.status} ${JSON.stringify(result)}`);
	}

	await new Promise((resolve) => setTimeout(resolve, 3000));
}

console.error('Could not publish the UI. Is the deployed Worker current?');
process.exit(1);
