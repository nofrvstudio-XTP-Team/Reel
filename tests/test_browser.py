"""Standalone Chromium UI smoke test, no internet or Cloudflare account required.
Requires: Python playwright, Chromium, ffmpeg. Uses a browser-local Blob MP4.
"""
import base64, json, pathlib, subprocess, tempfile
from playwright.sync_api import sync_playwright
ROOT=pathlib.Path(__file__).resolve().parents[1]
with tempfile.TemporaryDirectory() as temp:
 mp4=pathlib.Path(temp)/'demo.mp4'
 subprocess.run(['ffmpeg','-hide_banner','-loglevel','error','-y','-f','lavfi','-i','color=c=0x17312c:s=270x480:r=12','-f','lavfi','-i','sine=frequency=440:sample_rate=24000','-t','10','-c:v','libx264','-preset','ultrafast','-crf','33','-pix_fmt','yuv420p','-g','24','-c:a','aac','-b:a','32k','-movflags','+faststart',str(mp4)],check=True)
 video_b64=base64.b64encode(mp4.read_bytes()).decode('ascii')
 payload={'title':'Hội thoại mẫu','channel':'XTP JP','reels':[
  {'start':0,'end':4,'focusStart':1,'focusEnd':2.2,'ja':'こんにちは','vi':'Xin chào','tokens':[{'hira':'こんにちは','kanji':'','start':1,'end':2.2}]},
  {'start':4,'end':9,'focusStart':5,'focusEnd':6,'ja':'ありがとうございます','vi':'Xin cảm ơn','tokens':[]}]}
 with sync_playwright() as p:
  browser=p.chromium.launch(executable_path='/usr/bin/chromium',headless=True,args=['--no-sandbox','--autoplay-policy=no-user-gesture-required'])
  page=browser.new_page(viewport={'width':390,'height':844},is_mobile=True,has_touch=True)
  errors=[];page.on('pageerror',lambda e:errors.append(str(e)))
  html=(ROOT/'index.html').read_text().replace('<link rel="stylesheet" href="app.css">','').replace('<script src="app.js" defer></script>','').replace('<link rel="manifest" href="manifest.webmanifest">','').replace('<link rel="icon" type="image/svg+xml" href="icon.svg">','')
  page.set_content(html)
  page.add_style_tag(content=(ROOT/'app.css').read_text())
  prelude='''(() => {
    const videoData = Uint8Array.from(atob(VIDEO_B64),c => c.charCodeAt(0));
    window.__localVideo = URL.createObjectURL(new Blob([videoData],{type:'video/mp4'}));
    window.fetch = async (url) => {
      const str=String(url);
      if(str.includes('xtp-config.json')) return new Response(JSON.stringify({mediaBaseUrl:'https://mock.workers.dev'}),{status:200});
      if(str.includes('/api/library'))return new Response(JSON.stringify({videos:[{id:'lesson-01',bytes:videoData.length,uploaded:'2026-10-10T00:00:00Z'}],hasMore:false,cursor:null}),{status:200});
      if(str.includes('/api/reels/lesson-01'))return new Response(JSON.stringify(META),{status:200});
      return new Response('not found',{status:404});
    };
  })();'''.replace('VIDEO_B64',json.dumps(video_b64)).replace('META',json.dumps(payload,ensure_ascii=False))
  page.add_script_tag(content=prelude)
  script=(ROOT/'app.js').read_text().replace("video.src=basePath('/media/'+encodeURIComponent(reel.sourceId));","video.src=window.__localVideo;")
  page.add_script_tag(content=script)
  page.locator('#reelOverlay:not(.hidden)').wait_for(timeout=10000)
  assert page.locator('#captionBody').inner_text()=='Xin chào'
  assert page.locator('.reel-panel video').count()>=2
  page.locator('#caption').click()
  assert page.locator('#captionTag').inner_text()=='JP'
  assert 'こんにちは' in page.locator('#captionBody').inner_text()
  page.locator('#saveBtn').click()
  assert page.locator('#saveText').inner_text()=='Đã lưu'
  page.locator('#libraryBtn').click()
  assert 'lesson' in page.locator('.library-row').inner_text().lower()
  page.locator('#libraryClose').click()
  page.screenshot(path='/mnt/data/xtp_v13_browser_smoke.png',animations='disabled')
  page.locator('#gesture').dispatch_event('pointerdown',{'clientX':160,'clientY':620,'pointerId':1})
  page.locator('#gesture').dispatch_event('pointerup',{'clientX':160,'clientY':340,'pointerId':1})
  page.wait_for_timeout(400)
  assert page.locator('#captionBody').inner_text()=='Xin cảm ơn',page.locator('#captionBody').inner_text()
  assert not errors,errors
  print('Chromium browser smoke PASS: caption toggle, save, library, swipe, next reel, DOM errors:',errors)
  browser.close()
