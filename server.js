import http from "node:http";
import fs from "node:fs/promises";

const PORT = Number(process.env.PORT || 3000);
const TOKEN = process.env.TELEGRAM_BOT_TOKEN || "";
const CHAT = process.env.TELEGRAM_CHAT_ID || "";
const INTERVAL = Math.max(30, Number(process.env.SCAN_INTERVAL_SECONDS || 60)) * 1000;
const ALERT_SCORE = Number(process.env.ALERT_SCORE || 78);
const COOLDOWN_HOURS = Number(process.env.ALERT_COOLDOWN_HOURS || 6);
const TOP = Math.min(30, Math.max(5, Number(process.env.TOP_PER_MARKET || 20)));
let state = { lastScan:null, lastError:null, scanned:0, alertsSent:0, cooldowns:{} };
let busy = false;
try { state = {...state, ...JSON.parse(await fs.readFile("./state.json","utf8"))}; } catch {}
async function save(){ try { await fs.writeFile("./state.json",JSON.stringify(state,null,2)); } catch(e){console.error(e.message);} }
async function get(url){
  const r=await fetch(url,{signal:AbortSignal.timeout(12000),headers:{"User-Agent":"CoinRadarAI/1.0"}});
  if(!r.ok) throw new Error(`HTTP ${r.status} ${new URL(url).hostname}`);
  return r.json();
}
function analyze(c){
  let s=50, reasons=[];
  if(c.change>1&&c.change<12){s+=10;reasons.push("pozitif 24s momentum");}
  if(c.change>=12){s+=3;reasons.push("yüksek hareketlilik");}
  if(c.change< -5){s-=12;reasons.push("negatif günlük performans");}
  if(c.change< -12){s-=8;reasons.push("sert düşüş riski");}
  if(c.volume>50e6){s+=8;reasons.push("yüksek işlem hacmi");}
  else if(c.volume>10e6){s+=4;reasons.push("iyi işlem hacmi");}
  if(c.klines?.length>=12){
    const a=c.klines.map(k=>+k[4]), last=a.at(-1), prev=a.at(-2);
    const m5=a.slice(-5).reduce((x,y)=>x+y,0)/5, m12=a.slice(-12).reduce((x,y)=>x+y,0)/12;
    if(last>m5&&m5>m12){s+=12;reasons.push("kısa vadeli trend pozitif");}
    else if(last<m5&&m5<m12){s-=12;reasons.push("kısa vadeli trend zayıf");}
    if(prev>0&&(last/prev-1)*100>1.5){s+=5;reasons.push("son mumda ivme");}
  }
  if(c.market==="FUTURES"&&Number.isFinite(c.funding)){
    if(c.funding>0.001){s-=4;reasons.push("yüksek pozitif fonlama");}
    if(c.funding< -0.0005){s+=2;reasons.push("negatif fonlama");}
  }
  s=Math.max(0,Math.min(100,Math.round(s)));
  return {...c,score:s,reasons};
}
async function sendTelegram(message){
  if(!TOKEN||!CHAT){console.log("Telegram ayarlanmamış; sinyal:",message);return false;}
  const r=await fetch(`https://api.telegram.org/bot${TOKEN}/sendMessage`,{
    method:"POST",headers:{"content-type":"application/json"},
    body:JSON.stringify({chat_id:CHAT,text:message,disable_web_page_preview:true})
  });
  const j=await r.json(); if(!r.ok||!j.ok) throw new Error(j.description||"Telegram gönderilemedi");
  return true;
}
async function scanMarket(market){
  const spot=market==="SPOT", host=spot?"https://api.binance.com":"https://fapi.binance.com";
  const tickerPath=spot?"/api/v3/ticker/24hr":"/fapi/v1/ticker/24hr";
  const candlePath=spot?"/api/v3/klines":"/fapi/v1/klines";
  const tickers=await get(host+tickerPath);
  const selected=tickers.filter(t=>t.symbol.endsWith("USDT")&&+t.quoteVolume>=5e6)
    .sort((a,b)=>+b.quoteVolume-+a.quoteVolume).slice(0,TOP);
  return Promise.all(selected.map(async t=>{
    let klines=[],funding=NaN;
    try{klines=await get(`${host}${candlePath}?symbol=${t.symbol}&interval=15m&limit=20`);}catch(e){console.warn(t.symbol,e.message);}
    if(!spot){try{const p=await get(`${host}/fapi/v1/premiumIndex?symbol=${t.symbol}`);funding=+p.lastFundingRate;}catch{}}
    return analyze({symbol:t.symbol,market,price:+t.lastPrice,change:+t.priceChangePercent,volume:+t.quoteVolume,klines,funding});
  }));
}
async function scan(){
  if(busy)return; busy=true;
  try{
    const [spot,futures]=await Promise.all([scanMarket("SPOT"),scanMarket("FUTURES")]);
    const all=[...spot,...futures]; state.scanned=all.length; state.lastScan=new Date().toISOString(); state.lastError=null;
    for(const c of all){
      const opportunity=c.score>=ALERT_SCORE, risk=c.score<=30;
      if(!opportunity&&!risk)continue;
      const kind=opportunity?"opportunity":"risk", key=`${c.market}:${c.symbol}:${kind}`;
      if(Date.now()-(state.cooldowns[key]||0)<COOLDOWN_HOURS*3600000)continue;
      const msg=[
        `COIN RADAR AI | ${opportunity?"🟢 GÜÇLÜ FIRSAT ADAYI":"🔴 RİSK UYARISI"}`,
        `${c.symbol} · ${c.market==="SPOT"?"Spot":"Vadeli"} · Binance`,
        `Fiyat: ${c.price}`,
        `24 saat: ${c.change>=0?"+":""}${c.change.toFixed(2)}%`,
        `Radar skoru: ${c.score}/100`,
        `Hacim: ${Math.round(c.volume).toLocaleString("en-US")} USDT`,
        `Nedenler: ${c.reasons.join(", ")||"Sınırlı veri"}`,
        "",
        "Skor kesin yükseliş olasılığı değildir; yatırım tavsiyesi değildir."
      ].join("\n");
      try{await sendTelegram(msg);state.cooldowns[key]=Date.now();state.alertsSent++;}
      catch(e){state.lastError=e.message;console.error(e.message);}
    }
    console.log(`Tarama tamamlandı: ${all.length} parite`);
  }catch(e){state.lastError=e.message;console.error("Tarama hatası:",e.message);}
  finally{busy=false;await save();}
}
http.createServer((req,res)=>{
  if(req.url==="/"||req.url==="/health"){
    res.writeHead(200,{"content-type":"application/json; charset=utf-8"});
    res.end(JSON.stringify({service:"COIN RADAR AI",status:busy?"scanning":"running",lastScan:state.lastScan,scanned:state.scanned,alertsSent:state.alertsSent,telegramConfigured:!!(TOKEN&&CHAT),lastError:state.lastError},null,2));
  }else{res.writeHead(404);res.end("Not found");}
}).listen(PORT,()=>console.log("COIN RADAR AI health endpoint:",PORT));
await scan();
setInterval(scan,INTERVAL);
