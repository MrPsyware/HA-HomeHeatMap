const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const base = process.env.HEATMAP_TEST_URL || 'http://127.0.0.1:8100';
(async () => {
 const browser = await chromium.launch({executablePath:'/usr/bin/chromium',headless:true,args:['--no-sandbox']});
 const page = await browser.newPage({viewport:{width:1400,height:1000}});
 await page.addInitScript(() => {
  const clear = CanvasRenderingContext2D.prototype.clearRect, fill = CanvasRenderingContext2D.prototype.fillText;
  CanvasRenderingContext2D.prototype.clearRect = function(...args) { if (this.canvas.id === 'map') window.mapLabels = []; return clear.apply(this,args); };
  CanvasRenderingContext2D.prototype.fillText = function(value,...args) { if (this.canvas.id === 'map') (window.mapLabels ||= []).push(value); return fill.call(this,value,...args); };
 });
 const errors = []; page.on('pageerror',e=>errors.push(e.message));
 const poly = [{x:.05,y:.05},{x:.95,y:.05},{x:.95,y:.95},{x:.05,y:.95}];
 let layout = {version:1,revision:0,ignored:[],floors:['ground','first'].map((id,i)=>({id,name:id,ha_floor_id:id,image:'fixture.svg',rooms:[{id:id+'room',name:id+' room',polygon:poly}],doors:[],sensors:[{entity_id:'sensor.'+id+'_temperature',room_id:id+'room',point:{x:.3,y:.3}}]}))};
 const sensors = layout.floors.flatMap(f=>[{entity_id:'sensor.'+f.id+'_temperature',name:f.name+' temperature',metric:'temperature',device_id:f.id,floor_id:f.id,value:21},{entity_id:'sensor.'+f.id+'_humidity',name:f.name+' humidity',metric:'humidity',device_id:f.id,floor_id:f.id,value:55}]);
 for (let i=0;i<120;i++) sensors.push({entity_id:'sensor.wifi_'+i+'_rssi',name:'Wi-Fi device '+i,metric:'rssi',network:'wifi',floor_id:i%2?'first':'ground',value:-80+i%40});
 sensors.push({entity_id:'sensor.zigbee_lqi',name:'Zigbee sensor',metric:'lqi',network:'zigbee',floor_id:'ground',value:150});
 await page.route('**/fixture.svg',r=>r.fulfill({contentType:'image/svg+xml',body:'<svg xmlns="http://www.w3.org/2000/svg" width="900" height="650"><rect width="900" height="650" fill="#eee"/></svg>'}));
 await page.route('**/api/**',async r=>{
  const url=new URL(r.request().url()); let result;
  if(url.pathname.endsWith('/status')) result={configured:true};
  if(url.pathname.endsWith('/layout')) {
   if(r.request().method()==='PUT') {layout=r.request().postDataJSON();layout.revision++;}
   result=layout;
  }
  if(url.pathname.endsWith('/catalog')) result={sensors,floors:[{floor_id:'ground',name:'Ground'},{floor_id:'first',name:'First'}],warnings:[]};
  if(url.pathname.endsWith('/live')) result=sensors;
  if(url.pathname.endsWith('/history')) {
   assert.equal(url.searchParams.get('metric'),'humidity');
   result={start:Date.now()-3600000,end:Date.now(),resolution:'hour',warnings:[],series:{'sensor.first_humidity':[{start:Date.now()-7200000,end:Date.now()+1000,value:60}]}};
  }
  await r.fulfill({json:result});
 });
 await page.goto(base);
 await page.waitForFunction(()=>document.querySelector('#connection').textContent.includes('Connected'));
 await page.locator('#floor-list button').nth(1).click();
 await page.waitForFunction(()=>document.querySelector('#map-title').textContent==='first');
 await page.locator('#setup-toggle').click();
 await page.selectOption('#metric','humidity');
 await page.locator('#pair-humidity').click();
 assert.match(await page.locator('#pair-summary').textContent(),/Paired 2/);
 await page.locator('#save').click();
 await page.waitForFunction(()=>document.querySelector('#save-state').textContent==='All changes saved');
 assert.equal(layout.floors[1].sensors[1].metric,'humidity');
 await page.locator('#setup-toggle').click();
 await page.locator('#history-button').click();
 await page.waitForFunction(()=>!document.querySelector('#scrub').disabled);
 await page.locator('#live-button').click();
 await page.locator('#setup-toggle').click();
 await page.selectOption('#metric','rssi');
 assert.equal(await page.locator('#sensor-list .sensor').count(),60);
 await page.selectOption('#device-filter','all');
 assert.equal(await page.locator('#sensor-list .sensor').count(),120);
 await page.fill('#sensor-search','Wi-Fi device 0');
 const box=await page.locator('#map').boundingBox();
 await page.locator('#sensor-list .sensor > button').first().click();
 await page.mouse.click(box.x+box.width*.5,box.y+box.height*.5);
 await page.mouse.move(box.x+box.width*.5,box.y+box.height*.5);
 await page.mouse.down();
 await page.mouse.move(box.x+box.width*.6,box.y+box.height*.6,{steps:8});
 await page.mouse.up();
 await page.fill('#sensor-search','Wi-Fi device 1');
 await page.locator('#sensor-list .sensor').first().dragTo(page.locator('#map'),{targetPosition:{x:box.width*.2,y:box.height*.2}});
 await page.fill('#reference-name','Test AP');
 await page.locator('#add-reference').click();
 await page.mouse.click(box.x+box.width*.7,box.y+box.height*.5);
 await page.locator('#save').click();
 await page.waitForFunction(()=>document.querySelector('#save-state').textContent==='All changes saved');
 assert.equal(layout.floors[1].sensors.at(-1).metric,'rssi');
 assert.equal(layout.floors[1].references[0].name,'Test AP');
 assert.ok(Math.abs(layout.floors[1].sensors.find(s=>s.entity_id==='sensor.wifi_0_rssi').point.x-.6)<.01);
 assert.ok(layout.floors[1].sensors.some(s=>s.entity_id==='sensor.wifi_1_rssi'));
 await page.fill('#sensor-search','');
 await page.selectOption('#device-filter','unplaced');
 assert.equal(await page.locator('#sensor-list .sensor').count(),118);
 await page.screenshot({path:'/tmp/heatmap-features.png'});
 await page.goto(base + '/?embed=1&metrics=temperature,humidity&history=0');
 await page.waitForFunction(()=>document.querySelector('#connection').textContent.includes('Connected'));
 assert.equal(await page.locator('aside').isVisible(),false);
 assert.equal(await page.locator('#setup-toggle').isVisible(),false);
 assert.equal(await page.locator('#history-button').isVisible(),false);
 await page.selectOption('#metric','humidity');
 await page.selectOption('#embed-floor','first');
 await page.waitForFunction(()=>document.querySelector('#map-title').textContent==='first');
 await page.setViewportSize({width:450,height:550});
 await page.waitForTimeout(100);
 await page.screenshot({path:'/tmp/heatmap-card.png'});
 assert.deepEqual(await page.evaluate(()=>window.mapLabels), ['first room','55%']);
 const footer = await page.locator('.map-footer').boundingBox();
 assert.ok(footer.y + footer.height <= 551, 'compact footer fits in card');
 // Exercise the real custom-element lifecycle and iframe URL options.
 await page.addScriptTag({url:base + '/home-heat-map-card.js'});
 const cardConfig = await page.evaluate(base=>{
  const card=document.createElement('home-heat-map-card');
  card.setConfig({url:'http://127.0.0.1:8100/',metrics:['humidity'],history:false,floor:'first',device_labels:false});
  return {url:card.shadowRoot.querySelector('iframe').src,size:card.getCardSize()};
 }, base);
 assert.equal(new URL(cardConfig.url).searchParams.get('device_labels'),'0');
 assert.equal(new URL(cardConfig.url).searchParams.get('metrics'),'humidity');
 assert.ok(cardConfig.size>0);
 // Render 119 signal markers on the other floor, then scrub and switch layers.
 for(let i=1;i<120;i++) layout.floors[0].sensors.push({entity_id:'sensor.wifi_'+i+'_rssi',metric:'rssi',room_id:'',point:{x:.1+(i%12)*.07,y:.1+Math.floor(i/12)*.07}});
 await page.goto(base + '/?embed=1&metrics=rssi,lqi&floor=ground');
 await page.waitForFunction(()=>document.querySelector('#connection').textContent.includes('Connected'));
 assert.deepEqual(await page.evaluate(()=>window.mapLabels),['ground room']);
 await page.selectOption('#metric','lqi');
 assert.deepEqual(await page.evaluate(()=>window.mapLabels),['ground room']);
 assert.deepEqual(errors,[]);
 console.log('PASS: two floors, humidity pairing + save + history, 120-device filters, signal placement, references, compact card, no browser errors');
 await browser.close();
})().catch(e=>{console.error(e);process.exit(1)});
