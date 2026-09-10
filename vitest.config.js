import { defineWorkersConfig } from '@cloudflare/vitest-pool-workers/config';

export default defineWorkersConfig({
	test: {
		poolOptions: {
			workers: {
				wrangler: { configPath: './wrangler.jsonc' },
				// R2's sqlite files stay locked on Windows, which makes per-test storage
				// isolation fail on unrelated tests. Tests clean up after themselves instead.
				isolatedStorage: false,
				miniflare: {
					// Tests authorize with the token path; Access JWTs need a live team domain.
					bindings: { UPLOAD_TOKEN: 'test-token' },
				},
			},
		},
	},
});
