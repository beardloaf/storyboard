/**
 * Cloudflare Worker — CORS-friendly proxy for Black Forest Labs.
 *
 * Why this exists:
 *   - api.bfl.ai (image generation endpoints) doesn't send CORS headers.
 *   - delivery-*.bfl.ai (the CDN serving the actual rendered images) doesn't either.
 *   This Worker fronts both, adds CORS, and rewrites every BFL URL in the
 *   JSON responses so the browser keeps talking through this Worker instead
 *   of hitting BFL directly.
 *
 * Deploy:
 *   Workers & Pages → Create → "Hello World" Worker → Deploy →
 *   Edit code → replace with this file → Deploy again.
 *
 * Routing trick:
 *   Different upstream hosts are encoded in a `__upstream` query parameter.
 *   When the Worker rewrites a URL like
 *     https://delivery-eu1.bfl.ai/results/xyz.jpeg
 *   it becomes
 *     https://<worker>/results/xyz.jpeg?__upstream=delivery-eu1.bfl.ai
 *   and the Worker reads the param to know where to forward.
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
    fwdHeaders["accept"] = request.headers.get("accept") || "*/*";

    const upstream = await fetch(targetUrl, {
      method: request.method,
      headers: fwdHeaders,
      body: request.method === "POST" ? await request.arrayBuffer() : undefined,
    });

    const contentType = upstream.headers.get("content-type") || "";

    // JSON responses: rewrite any BFL URLs so the browser stays on the proxy
    if (contentType.includes("application/json")) {
      let bodyText = await upstream.text();
      try {
        const parsed = JSON.parse(bodyText);
        let changed = false;
        const rewrite = (rawUrl) => {
          const pu = new URL(rawUrl);
          const sep = pu.search ? "&" : "?";
          return `${reqUrl.origin}${pu.pathname}${pu.search}${sep}__upstream=${pu.host}`;
        };
        if (parsed.polling_url) {
          parsed.polling_url = rewrite(parsed.polling_url);
          changed = true;
        }
        if (parsed.result && typeof parsed.result.sample === "string" && parsed.result.sample.startsWith("http")) {
          parsed.result.sample = rewrite(parsed.result.sample);
          changed = true;
        }
        if (changed) bodyText = JSON.stringify(parsed);
      } catch (_) {}
      return new Response(bodyText, {
        status: upstream.status,
        headers: { ...corsHeaders, "content-type": contentType },
      });
    }

    // Binary (the image itself): stream straight through with CORS
    return new Response(upstream.body, {
      status: upstream.status,
      headers: { ...corsHeaders, "content-type": contentType },
    });
  },
};
