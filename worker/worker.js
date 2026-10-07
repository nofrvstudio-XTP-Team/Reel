const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,HEAD,OPTIONS',
  'Access-Control-Allow-Headers': 'Range,Content-Type',
  'Access-Control-Expose-Headers': 'Accept-Ranges,Content-Range,Content-Length,ETag,Last-Modified',
};

function baseHeaders(extra = {}) {
  return new Headers({
    ...CORS,
    'Cache-Control': 'public, max-age=31536000, immutable',
    ...extra,
  });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: baseHeaders() });
    }

    if (url.pathname === '/health') {
      return Response.json({ ok: true }, { headers: baseHeaders({ 'Cache-Control': 'no-store' }) });
    }

    const match = url.pathname.match(/^\/media\/([A-Za-z0-9_-]{11})$/);
    if (!match) return new Response('Not found', { status: 404, headers: baseHeaders() });
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return new Response('Method not allowed', { status: 405, headers: baseHeaders({ Allow: 'GET, HEAD, OPTIONS' }) });
    }

    const key = `youtube/${match[1]}.mp4`;
    const meta = await env.MEDIA.head(key);
    if (!meta) return new Response(null, { status: 404, headers: baseHeaders({ 'Cache-Control': 'no-store' }) });

    const headers = baseHeaders();
    meta.writeHttpMetadata(headers);
    headers.set('Content-Type', meta.httpMetadata?.contentType || 'video/mp4');
    headers.set('Accept-Ranges', 'bytes');
    headers.set('ETag', meta.httpEtag);
    headers.set('Last-Modified', meta.uploaded.toUTCString());

    if (request.method === 'HEAD') {
      headers.set('Content-Length', String(meta.size));
      return new Response(null, { status: 200, headers });
    }

    const rangeHeader = request.headers.get('Range');
    const object = await env.MEDIA.get(key, rangeHeader ? { range: request.headers } : undefined);
    if (!object || !('body' in object)) {
      return new Response(null, { status: object ? 412 : 404, headers });
    }

    object.writeHttpMetadata(headers);
    headers.set('Content-Type', object.httpMetadata?.contentType || 'video/mp4');
    headers.set('ETag', object.httpEtag);
    headers.set('Accept-Ranges', 'bytes');

    if (rangeHeader && object.range) {
      const offset = object.range.offset || 0;
      const length = object.range.length || 0;
      headers.set('Content-Range', `bytes ${offset}-${offset + length - 1}/${meta.size}`);
      headers.set('Content-Length', String(length));
      return new Response(object.body, { status: 206, headers });
    }

    headers.set('Content-Length', String(meta.size));
    return new Response(object.body, { status: 200, headers });
  }
};
