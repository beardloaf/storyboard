/**
 * Cloudflare Worker — CORS-friendly proxy for Black Forest Labs (api.bfl.ai).
 *
 * Why this exists:
 *   BFL doesn't send Access-Control-Allow-Origin headers, so api.bfl.ai
 *   cannot be called directly from a browser. This Worker sits in front
 *   of BFL, adds the CORS headers, and forwards the request transparently.
 *   Your BFL key still travels client→Worker→BFL via the `x-key` header.
 *
 * Deploy (3 minutes, free):
 *   1. Go to https://dash.cloudflare.com → "Workers & Pages" → "Create" → "Create Worker"
 *   2. Name it (e.g. "bfl-proxy"), click Deploy
 *   3. Click "Edit code" on the worker overview
 *   4. Replace ALL the default code with the contents of this file
 *   5. Click "Save and deploy"
 *   6. Copy the worker URL (e.g. https://bfl-proxy.<your-subdomain>.workers.dev)
 *   7. In the storyboard app, ⚙ API keys → paste the URL into "BFL Proxy URL"
 *
 * Polling note:
 *   BFL's POST response contains a polling_url pointing back at api.bfl.ai
 *   (sometimes a regional subdomain). This Worker rewrites that URL so the
 *   browser polls through the Worker too, preserving CORS. The upstream host
 *   is encoded into a __upstream query param to survive regional endpoints.
 */

export default {
  async fetch(request) {
    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, x-key, accept",
      "Access-Control-Max-Age": "86400",
    };

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders });
    }

    const reqUrl = new URL(request.url);
    const upstreamHost = reqUrl.searchParams.get("__upstream") || "api.bfl.ai";
    reqUrl.searchParams.delete("__upstream");
    const targetUrl = `https://${upstreamHost}${reqUrl.pathname}${reqUrl.search}`;

    const fwdHeaders = {};
    const xKey = request.headers.get("x-key");
    if (xKey) fwdHeaders["x-key"] = xKey;
    const ct = request.headers.get("content-type");
    if (ct) fwdHeaders["content-type"] = ct;
    fwdHeaders["accept"] = "application/json";

    const upstream = await fetch(targetUrl, {
      method: request.method,
      headers: fwdHeaders,
      body: request.method === "POST" ? await request.arrayBuffer() : undefined,
    });

    let bodyText = await upstream.text();
    try {
      const parsed = JSON.parse(bodyText);
      if (parsed.polling_url) {
        const pu = new URL(parsed.polling_url);
        const sep = pu.search ? "&" : "?";
        parsed.polling_url = `${reqUrl.origin}${pu.pathname}${pu.search}${sep}__upstream=${pu.host}`;
        bodyText = JSON.stringify(parsed);
      }
    } catch (_) {}

    return new Response(bodyText, {
      status: upstream.status,
      headers: {
        ...corsHeaders,
        "content-type": upstream.headers.get("content-type") || "application/json",
      },
    });
  },
};
