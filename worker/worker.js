/**
 * XTP JP v13 — read-only R2 media API.
 * Uploads and deletes are done exclusively in Cloudflare Dashboard.
 * Public library; do not use for private or copyrighted material without permission.
 */
const ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/;
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
  'Access-Control-Allow-Headers': 'Range, If-Range, Content-Type',
  'Access-Control-Expose-Headers': 'Accept-Ranges, Content-Range, Content-Length, ETag, Last-Modified',
  'X-Content-Type-Options': 'nosniff',
};
function headers(extra = {}) { return new Headers({ ...CORS, ...extra }); }
function replyJSON(data, status=200, cache='no-store') {
  return new Response(JSON.stringify(data), {
    status, headers: headers({'Content-Type':'application/json; charset=utf-8','Cache-Control':cache}),
  });
}
function error(message, status) { return replyJSON({error:message},status); }
function parseRange(value,size) {
  // Only one byte range. Suffix and open-ended forms supported.
  const match = /^bytes=(\d*)-(\d*)$/.exec(value.trim());
  if (!match || (!match[1] && !match[2]) || size <= 0) return null;
  let first, last;
  if (!match[1]) {
    const suffix = Number(match[2]);
    if (!Number.isSafeInteger(suffix) || suffix <= 0) return null;
    first = Math.max(0,size-suffix);
    last = size-1;
  } else {
    first = Number(match[1]);
    last = match[2] ? Number(match[2]) : size-1;
    if (!Number.isSafeInteger(first) || !Number.isSafeInteger(last) || first>=size || first>last) return null;
    last = Math.min(last,size-1);
  }
  return {offset:first, length:last-first+1, last};
}
async function serveMedia(request,env,key,type) {
  // HEAD is issued separately, but GET never buffers the media in Worker memory.
  if (request.method !== 'GET' && request.method !== 'HEAD') return error('Method not allowed',405);
  const meta = await env.MEDIA.head(key);
  if (!meta) return error('Không tìm thấy file',404);
  const out = headers({
    'Content-Type':type,
    'Cache-Control':'public, max-age=300',
    'Accept-Ranges':'bytes',
    'ETag':meta.httpEtag,
    'Last-Modified':meta.uploaded.toUTCString(),
  });
  let range = null;
  const rangeString = request.headers.get('Range');
  if (rangeString) {
    range = parseRange(rangeString,meta.size);
    if (!range) {
      out.set('Content-Range',`bytes */${meta.size}`);
      return new Response(null,{status:416,headers:out});
    }
  }
  out.set('Content-Length',String(range ? range.length : meta.size));
  if (range) out.set('Content-Range',`bytes ${range.offset}-${range.last}/${meta.size}`);
  if (request.method === 'HEAD') return new Response(null,{status:range ? 206 : 200,headers:out});
  const object = await env.MEDIA.get(key,range ? {range:{offset:range.offset,length:range.length}} : undefined);
  if (!object?.body) return error('Không đọc được file',502);
  return new Response(object.body,{status:range ? 206 : 200,headers:out});
}
export default {
  async fetch(request,env) {
    if (request.method==='OPTIONS') return new Response(null,{status:204,headers:headers({'Cache-Control':'max-age=86400'})});
    const url = new URL(request.url);
    if (url.pathname==='/health') return replyJSON({ok:true,version:13,mode:'manual-r2'},200,'no-store');
    if (request.method!=='GET' && request.method!=='HEAD') return error('Chỉ hỗ trợ đọc dữ liệu',405);
    if (!env.MEDIA) return error('Thiếu binding MEDIA',503);
    try {
      if (url.pathname==='/api/library') {
        const cursor=url.searchParams.get('cursor')||undefined;
        if (cursor && cursor.length>2048) return error('Cursor quá dài',400);
        const list=await env.MEDIA.list({prefix:'videos/',limit:1000,...(cursor?{cursor}:{})});
        const videos=list.objects.filter(item=>/^videos\/[A-Za-z0-9][A-Za-z0-9_-]{0,79}\.mp4$/.test(item.key))
          .map(item=>({id:item.key.slice(7,-4),bytes:item.size,uploaded:item.uploaded?.toISOString()||null}));
        return replyJSON({videos,hasMore:list.truncated===true,cursor:list.truncated?list.cursor:null},200,'public, max-age=30');
      }
      let m=url.pathname.match(/^\/api\/reels\/([A-Za-z0-9_-]+)$/);
      if (m && ID.test(m[1])) {
        const key=`videos/${m[1]}.json`;
        const meta=await env.MEDIA.head(key);
        if(!meta) return error('Chưa có JSON reel',404);
        if(meta.size>262144) return error('JSON vượt 256 KB',413);
        const object=await env.MEDIA.get(key);
        if(!object?.body) return error('Không đọc được JSON',502);
        const out=headers({'Content-Type':'application/json; charset=utf-8','Cache-Control':'public, max-age=60', 'Content-Length':String(meta.size)});
        if(request.method==='HEAD') return new Response(null,{status:200,headers:out});
        return new Response(object.body,{status:200,headers:out});
      }
      m=url.pathname.match(/^\/media\/([A-Za-z0-9_-]+)$/);
      if(m && ID.test(m[1])) return serveMedia(request,env,`videos/${m[1]}.mp4`,'video/mp4');
      m=url.pathname.match(/^\/poster\/([A-Za-z0-9_-]+)$/);
      if(m && ID.test(m[1])) return serveMedia(request,env,`videos/${m[1]}.jpg`,'image/jpeg');
      return error('Not found',404);
    } catch(e) {
      console.error('R2 Worker:',e);
      return error('Lỗi R2/Worker, xem log Cloudflare',502);
    }
  }
};
export {parseRange};
