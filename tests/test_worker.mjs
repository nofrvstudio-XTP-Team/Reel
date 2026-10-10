import assert from 'node:assert/strict';
import worker,{parseRange} from '../worker/worker.js';
const file = Buffer.from('abcdefghijklmnopqrstuvwxyz');
const manifest = Buffer.from('{"title":"test","reels":[]}');
const objects = new Map([
 ['videos/lesson-01.mp4',file],['videos/lesson-01.json',manifest],
 ['videos/ignore.txt',Buffer.from('not video')]
]);
const meta=(key)=>objects.has(key)?{
 size:objects.get(key).length,httpEtag:'"mock-etag"',uploaded:new Date('2026-10-10T01:00:00Z')
}:null;
const MEDIA={
 async head(key){return meta(key);},
 async list(){return {objects:[...objects.keys()].map(key=>({key,size:objects.get(key).length,uploaded:new Date('2026-10-10T01:00:00Z')})),truncated:false,cursor:null};},
 async get(key,options){if(!objects.has(key))return null;const blob=objects.get(key);const part=options?.range ? blob.subarray(options.range.offset,options.range.offset+options.range.length):blob;return {...meta(key),body:new Blob([part]).stream()};}
};
const req=(path,headers={},method='GET')=>worker.fetch(new Request('https://example.workers.dev'+path,{headers,method}),{MEDIA});
let r=await req('/health');assert.equal(r.status,200);assert.equal((await r.json()).version,13);
r=await req('/api/library');assert.equal(r.status,200);assert.deepEqual((await r.json()).videos.map(v=>v.id),['lesson-01']);
r=await req('/api/reels/lesson-01');assert.equal(r.status,200);assert.equal(await r.text(),manifest.toString());
r=await req('/api/reels/other');assert.equal(r.status,404);
r=await req('/media/lesson-01',{Range:'bytes=5-10'});assert.equal(r.status,206);assert.equal(r.headers.get('Content-Range'),'bytes 5-10/26');assert.equal(await r.text(),'fghijk');
r=await req('/media/lesson-01',{Range:'bytes=-3'});assert.equal(r.status,206);assert.equal(await r.text(),'xyz');
r=await req('/media/lesson-01',{Range:'bytes=999-'});assert.equal(r.status,416);assert.equal(r.headers.get('Content-Range'),'bytes */26');
r=await req('/media/lesson-01',{},'HEAD');assert.equal(r.status,200);assert.equal(r.headers.get('Content-Length'),'26');
r=await req('/media/lesson-01');assert.equal(r.status,200);assert.equal(await r.text(),file.toString());
r=await req('/media/lesson-01',{},'POST');assert.equal(r.status,405);
r=await req('/media/a%2Fb');assert.equal(r.status,404);
assert.deepEqual(parseRange('bytes=0-0',26),{offset:0,length:1,last:0});
console.log('Worker tests passed: health/library/JSON/range/HEAD/no-write/invalid IDs');
