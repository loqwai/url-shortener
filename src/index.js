export default {
	async fetch(request, env, ctx) {
		// if it's a get, return 'hi'
		if (request.method === 'GET') {
			const shortcode = request.url.split('/').pop()
			// if the url is in the kv, return the url as a permanent redirect
			const url = await env.URL_MAP.get(shortcode)
			if (url) return new Response(url, { status: 301 })
			return new Response('Not found', { status: 404 })
		}
		if (request.method === 'POST') {
			// if the url is not in the kv, add it and return the url.
			// get the shortcode by parsing the url
			const shortcode = request.url.split('/').pop()
			const url = await env.URL_MAP.get(shortcode)
			if (url) return new Response('Short code already exists', { status: 400 })
			const data = await request.json()
			const postBodyUrl = data.url
			if (!postBodyUrl) return new Response('Missing url', { status: 400 })
			await env.URL_MAP.put(shortcode, postBodyUrl)

			return new Response(
				JSON.stringify({ url: request.url.split('/').slice(0, -1).join('/') + '/' + shortcode }),
				{
					status: 201,
					headers: {
						'Content-Type': 'application/json'
					}
				}
			)
		}
	},
};
