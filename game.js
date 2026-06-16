// TRAIL MAINTENANCE — a quiet horror walking sim. PS1/VHS treatment, Three.js.
import * as THREE from "./vendor/three.module.js";
import { GLTFLoader } from "./vendor/GLTFLoader.js";
import { mergeGeometries } from "./vendor/BufferGeometryUtils.js";
import { STR } from "./strings.js";

/* ============================ utilities ============================ */
function mulberry32(a){return function(){a|=0;a=a+0x6D2B79F5|0;let t=Math.imul(a^a>>>15,1|a);
  t=t+Math.imul(t^t>>>7,61|t)^t;return((t^t>>>14)>>>0)/4294967296}}
const rng = mulberry32(61114); // seeded — same forest every shift
const R=(a,b)=>a+rng()*(b-a);
const clamp=(v,a,b)=>Math.max(a,Math.min(b,v));
const lerp=(a,b,t)=>a+(b-a)*t;
const $=id=>document.getElementById(id);

const IS_TOUCH = matchMedia("(pointer:coarse)").matches || "ontouchstart" in window;
const HAS_MOUSE = matchMedia("(pointer:fine)").matches || matchMedia("(any-pointer:fine)").matches || !IS_TOUCH;
const DEV = new URLSearchParams(location.search).has("dev");

/* ============================ audio ============================ */
const AudioSys = {
  ctx:null, master:null, windGain:null, cricketGain:null, buffers:{}, ready:false,
  async init(){
    this.ctx = new (window.AudioContext||window.webkitAudioContext)();
    const c=this.ctx;
    this.master=c.createGain(); this.master.gain.value=0.9; this.master.connect(c.destination);
    // safety limiter — nothing should ever spike harsh
    const comp=c.createDynamicsCompressor();
    comp.threshold.value=-12; comp.ratio.value=8; comp.attack.value=0.003; comp.release.value=0.25;
    this.master.disconnect(); this.master.connect(comp); comp.connect(c.destination);
    const files={wind:"sfx_wind",steps:"sfx_steps",static:"sfx_static",hammer:"sfx_hammer",
                 brush:"sfx_brush",vo1:"vo_dispatch_continue",vo2:"vo_dispatch_confirmed"};
    await Promise.all(Object.entries(files).map(async([k,f])=>{
      try{
        const r=await fetch(`./assets/audio/${f}.mp3`); const ab=await r.arrayBuffer();
        this.buffers[k]=await c.decodeAudioData(ab);
      }catch(e){ console.warn("audio missing",f,e); }
    }));
    // ambient wind loop
    this.windGain=c.createGain(); this.windGain.gain.value=0.0; this.windGain.connect(this.master);
    if(this.buffers.wind){
      const s=c.createBufferSource(); s.buffer=this.buffers.wind; s.loop=true;
      const lp=c.createBiquadFilter(); lp.type="lowpass"; lp.frequency.value=2400;
      s.connect(lp); lp.connect(this.windGain); s.start();
    }
    // procedural crickets — sparse, quiet
    this.cricketGain=c.createGain(); this.cricketGain.gain.value=0.0; this.cricketGain.connect(this.master);
    this._cricketLoop();
    this.ready=true;
  },
  setWind(v,t=2){ if(this.windGain) this.windGain.gain.linearRampToValueAtTime(v,this.ctx.currentTime+t); },
  setCrickets(v,t=2){ if(this.cricketGain) this.cricketGain.gain.linearRampToValueAtTime(v,this.ctx.currentTime+t); },
  _cricketLoop(){
    const c=this.ctx, g=this.cricketGain;
    const chirp=()=>{ if(!g) return;
      const n=2+((rng()*3)|0);
      for(let i=0;i<n;i++){
        const o=c.createOscillator(), eg=c.createGain();
        o.type="sine"; o.frequency.value=4200+R(-300,300);
        eg.gain.setValueAtTime(0,c.currentTime+i*0.07);
        eg.gain.linearRampToValueAtTime(0.05,c.currentTime+i*0.07+0.015);
        eg.gain.linearRampToValueAtTime(0,c.currentTime+i*0.07+0.05);
        o.connect(eg); eg.connect(g); o.start(c.currentTime+i*0.07); o.stop(c.currentTime+i*0.07+0.08);
      }
      setTimeout(chirp, 900+Math.random()*2600);
    };
    setTimeout(chirp,1500);
  },
  // positional one-shot: pan + distance attenuation against listener (player)
  play3D(name, x, z, opts={}){
    if(!this.buffers[name]) return;
    const c=this.ctx, p=Game.player;
    const dx=x-p.x, dz=z-p.z, d=Math.hypot(dx,dz);
    // pan relative to facing
    const fx=Math.sin(p.yaw), fz=Math.cos(p.yaw);              // forward
    const rx=Math.cos(p.yaw), rz=-Math.sin(p.yaw);             // right
    const side=clamp((dx*rx+dz*rz)/Math.max(d,0.001),-1,1);
    const dist=clamp(1-(d/(opts.range||45)),0,1);
    const s=c.createBufferSource(); s.buffer=this.buffers[name];
    if(opts.rate) s.playbackRate.value=opts.rate;
    const pan=c.createStereoPanner(); pan.pan.value=side*0.8;
    const g=c.createGain(); g.gain.value=(opts.vol??0.8)*Math.pow(dist,1.4);
    const lp=c.createBiquadFilter(); lp.type="lowpass"; lp.frequency.value=lerp(700,8000,dist);
    s.connect(lp); lp.connect(pan); pan.connect(g); g.connect(this.master);
    s.start(c.currentTime,(opts.offset||0), opts.dur);
    return s;
  },
  play(name, vol=0.8, opts={}){
    if(!this.buffers[name]) return null;
    const c=this.ctx, s=c.createBufferSource(); s.buffer=this.buffers[name];
    if(opts.rate) s.playbackRate.value=opts.rate;
    const g=c.createGain(); g.gain.value=vol;
    let node=s;
    if(opts.radio){ node=this._radioChain(s); }
    else if(opts.garble){ node=this._garbleChain(s); }
    node.connect(g); g.connect(this.master);
    s.start(c.currentTime, opts.offset||0, opts.dur);
    return s;
  },
  _radioChain(src){
    const c=this.ctx;
    const bp=c.createBiquadFilter(); bp.type="bandpass"; bp.frequency.value=1400; bp.Q.value=0.9;
    const ws=c.createWaveShaper();
    const curve=new Float32Array(256);
    for(let i=0;i<256;i++){const x=i/128-1;curve[i]=Math.tanh(x*3);}
    ws.curve=curve;
    src.connect(bp); bp.connect(ws);
    return ws;
  },
  // garbled radio: the voice is there but words can't be made out — a wobbling
  // narrow bandpass + ring-modulation tremolo + hard distortion smear it.
  _garbleChain(src){
    const c=this.ctx, now=c.currentTime;
    const bp=c.createBiquadFilter(); bp.type="bandpass"; bp.frequency.value=1100; bp.Q.value=6;
    const lfo=c.createOscillator(); lfo.type="sine"; lfo.frequency.value=7.5;
    const lfoG=c.createGain(); lfoG.gain.value=650;
    lfo.connect(lfoG); lfoG.connect(bp.frequency); lfo.start(now);
    const ring=c.createGain(); ring.gain.value=0.5;
    const ros=c.createOscillator(); ros.type="square"; ros.frequency.value=22;
    const rg=c.createGain(); rg.gain.value=0.5;
    ros.connect(rg); rg.connect(ring.gain); ros.start(now);
    const ws=c.createWaveShaper(); const curve=new Float32Array(256);
    for(let i=0;i<256;i++){const x=i/128-1;curve[i]=Math.tanh(x*7);}
    ws.curve=curve;
    src.connect(bp); bp.connect(ring); ring.connect(ws);
    return ws;
  },
  // little procedural sounds
  snap(x,z){ // dry branch crack
    const c=this.ctx, len=0.18, b=c.createBuffer(1,c.sampleRate*len,c.sampleRate), d=b.getChannelData(0);
    for(let i=0;i<d.length;i++){const t=i/d.length;d[i]=(Math.random()*2-1)*Math.pow(1-t,3)*(t<0.02?2.2:1);}
    this._burst3D(b,x,z,0.9,1400);
  },
  rustle(x,z){ // dragging a branch off the path
    const c=this.ctx, len=0.9, b=c.createBuffer(1,c.sampleRate*len,c.sampleRate), d=b.getChannelData(0);
    let v=0; for(let i=0;i<d.length;i++){const t=i/d.length;v=v*0.92+(Math.random()*2-1)*0.4;
      d[i]=v*Math.sin(t*Math.PI)*0.9;}
    this._burst3D(b,x,z,0.7,900);
  },
  creak(x,z){
    const c=this.ctx,o=c.createOscillator(),g=c.createGain();
    o.type="sawtooth"; o.frequency.setValueAtTime(90,c.currentTime);
    o.frequency.exponentialRampToValueAtTime(55,c.currentTime+1.1);
    g.gain.setValueAtTime(0.0,c.currentTime);
    g.gain.linearRampToValueAtTime(0.06,c.currentTime+0.15);
    g.gain.linearRampToValueAtTime(0,c.currentTime+1.2);
    const lp=c.createBiquadFilter();lp.type="lowpass";lp.frequency.value=500;
    o.connect(lp);lp.connect(g);g.connect(this.master);o.start();o.stop(c.currentTime+1.3);
  },
  murmur(){ // faint families arriving — bad ending
    const c=this.ctx, len=6, b=c.createBuffer(1,c.sampleRate*len,c.sampleRate), d=b.getChannelData(0);
    let v=0;
    for(let i=0;i<d.length;i++){v=v*0.995+(Math.random()*2-1)*0.05; d[i]=v;}
    const s=c.createBufferSource(); s.buffer=b; s.loop=true;
    const bp=c.createBiquadFilter(); bp.type="bandpass"; bp.frequency.value=600; bp.Q.value=0.5;
    const g=c.createGain(); g.gain.value=0; g.gain.linearRampToValueAtTime(0.18,c.currentTime+5);
    s.connect(bp); bp.connect(g); g.connect(this.master); s.start();
    // occasional bright distant "voices"
    const blip=()=>{const o=c.createOscillator(),eg=c.createGain();
      o.type="sine";o.frequency.value=500+Math.random()*700;
      eg.gain.setValueAtTime(0,c.currentTime);eg.gain.linearRampToValueAtTime(0.02,c.currentTime+0.08);
      eg.gain.linearRampToValueAtTime(0,c.currentTime+0.4);
      o.connect(eg);eg.connect(g);o.start();o.stop(c.currentTime+0.5);
      setTimeout(blip,600+Math.random()*1400);};
    setTimeout(blip,2000);
  },
  _burst3D(buffer,x,z,vol,lpf){
    const c=this.ctx, p=Game.player;
    const dx=x-p.x,dz=z-p.z,d=Math.hypot(dx,dz);
    const rx=Math.cos(p.yaw),rz=-Math.sin(p.yaw);
    const side=clamp((dx*rx+dz*rz)/Math.max(d,0.001),-1,1);
    const dist=clamp(1-d/40,0,1);
    const s=c.createBufferSource();s.buffer=buffer;
    const pan=c.createStereoPanner();pan.pan.value=side*0.8;
    const g=c.createGain();g.gain.value=vol*Math.pow(dist,1.3);
    const lp=c.createBiquadFilter();lp.type="lowpass";lp.frequency.value=lpf;
    s.connect(lp);lp.connect(pan);pan.connect(g);g.connect(this.master);s.start();
  },
  staticBurst(vol=0.5,dur=2.2){
    if(this.buffers.static) this.play("static",vol,{dur});
    else{ const c=this.ctx,len=dur,b=c.createBuffer(1,c.sampleRate*len,c.sampleRate),d=b.getChannelData(0);
      for(let i=0;i<d.length;i++)d[i]=(Math.random()*2-1)*0.5;
      const s=c.createBufferSource();s.buffer=b;const g=c.createGain();g.gain.value=vol*0.4;
      s.connect(g);g.connect(this.master);s.start(); }
  },
  dispatch(which, after=0.8){
    // static lead-in, then a garbled transmission you can't make out, static tail
    this.staticBurst(0.4,1.1);
    setTimeout(()=>{ this.play(which==="continue"?"vo1":"vo2",0.95,{garble:true});
      UI.radioLine(STR.radioGarbled);
      setTimeout(()=>this.staticBurst(0.3,0.9), 1600);
    }, after*1000);
  },
  // the concerned transmission at the clearing — clearer than the dispatch lines,
  // a real voice that has noticed where you are. Text surfaces on-screen.
  dispatchConcerned(){
    this.staticBurst(0.5,1.3);
    setTimeout(()=>{
      // reuse a voice clip but cleaner (radio chain, not garble) so a human reads through
      this.play("vo1",1.0,{radio:true});
      UI.radioLine(STR.radioConcerned1);
      UI.glitch();
    }, 1300);
    setTimeout(()=>{ this.play("vo2",1.0,{radio:true}); UI.radioLine(STR.radioConcerned2); }, 4200);
    setTimeout(()=>this.staticBurst(0.4,1.4), 6800);
  },
  footstep(){
    if(!this.buffers.steps){ // procedural thud fallback
      const c=this.ctx,len=0.12,b=c.createBuffer(1,c.sampleRate*len,c.sampleRate),d=b.getChannelData(0);
      for(let i=0;i<d.length;i++){const t=i/d.length;d[i]=(Math.random()*2-1)*Math.pow(1-t,4)*0.8;}
      const s=c.createBufferSource();s.buffer=b;const g=c.createGain();g.gain.value=0.25;
      const lp=c.createBiquadFilter();lp.type="lowpass";lp.frequency.value=400;
      s.connect(lp);lp.connect(g);g.connect(this.master);s.start(); return;}
    // the generated clip holds 4 steps over ~3s — pick one
    const i=(Math.random()*4)|0;
    this.play("steps",0.5,{offset:i*0.72,dur:0.42,rate:0.95+Math.random()*0.1});
  }
};

/* ============================ input ============================ */
const Input = {
  held:new Set(), look:{dx:0,dy:0}, interact:false, flash:false, locked:false,
  stick:{active:false,id:-1,ox:0,oy:0,x:0,y:0},
  lookTouch:{active:false,id:-1,lx:0,ly:0},
  init(canvas){
    const BIND={KeyW:"up",KeyS:"down",KeyA:"left",KeyD:"right",
                ArrowUp:"up",ArrowDown:"down",ArrowLeft:"left",ArrowRight:"right",
                KeyE:"interact",KeyF:"flash",Space:"interact"};
    addEventListener("keydown",e=>{const c=BIND[e.code];if(!c)return;e.preventDefault();
      if(c==="interact"){if(!this.held.has(c))this.interact=true;}
      if(c==="flash"){if(!this.held.has(c))this.flash=true;}
      this.held.add(c);});
    addEventListener("keyup",e=>{const c=BIND[e.code];if(c)this.held.delete(c);});
    // pointer lock mouse look — relock on any canvas click while playing/starting
    canvas.addEventListener("mousedown",()=>{ if(!this.locked && (Game.state==="play"||Game.state==="starting")) canvas.requestPointerLock?.(); });
    document.addEventListener("pointerlockchange",()=>{ this.locked = document.pointerLockElement===canvas; });
    document.addEventListener("pointerlockerror",()=>{ this.locked=false; });
    addEventListener("mousemove",e=>{ if(this.locked){ this.look.dx+=e.movementX; this.look.dy+=e.movementY; }});
    // touch — left half stick, right half look, plus HTML buttons
    if(IS_TOUCH){
      $("stick").style.display="block"; $("btnE").style.display="block"; $("btnF").style.display="block";
      const onTS=e=>{ for(const t of e.changedTouches){
        if(t.clientX<innerWidth*0.45 && !this.stick.active){
          this.stick={active:true,id:t.identifier,ox:t.clientX,oy:t.clientY,x:0,y:0};
          const s=$("stick"); s.style.left=(t.clientX-55)+"px"; s.style.top=(t.clientY-55)+"px"; s.style.bottom="auto";
        } else if(t.clientX>=innerWidth*0.45 && !this.lookTouch.active){
          this.lookTouch={active:true,id:t.identifier,lx:t.clientX,ly:t.clientY};
        }} e.preventDefault(); };
      const onTM=e=>{ for(const t of e.changedTouches){
        if(this.stick.active&&t.identifier===this.stick.id){
          this.stick.x=clamp((t.clientX-this.stick.ox)/45,-1,1);
          this.stick.y=clamp((t.clientY-this.stick.oy)/45,-1,1);
          $("nub").style.transform=`translate(${this.stick.x*30}px,${this.stick.y*30}px)`;
        }
        if(this.lookTouch.active&&t.identifier===this.lookTouch.id){
          this.look.dx+=(t.clientX-this.lookTouch.lx)*2.2;
          this.look.dy+=(t.clientY-this.lookTouch.ly)*2.2;
          this.lookTouch.lx=t.clientX; this.lookTouch.ly=t.clientY;
        }} e.preventDefault(); };
      const onTE=e=>{ for(const t of e.changedTouches){
        if(this.stick.active&&t.identifier===this.stick.id){this.stick={active:false,id:-1,x:0,y:0};
          $("nub").style.transform="";const s=$("stick");s.style.left="30px";s.style.top="auto";s.style.bottom="40px";}
        if(this.lookTouch.active&&t.identifier===this.lookTouch.id)this.lookTouch.active=false;
      } e.preventDefault(); };
      addEventListener("touchstart",onTS,{passive:false});
      addEventListener("touchmove",onTM,{passive:false});
      addEventListener("touchend",onTE,{passive:false});
      addEventListener("touchcancel",onTE,{passive:false});
      $("btnE").addEventListener("touchstart",e=>{this.interact=true;e.stopPropagation();e.preventDefault();},{passive:false});
      $("btnF").addEventListener("touchstart",e=>{this.flash=true;e.stopPropagation();e.preventDefault();},{passive:false});
    }
  },
  pad(){
    let mx=0,mz=0,lx=0,ly=0,A=false,B=false;
    for(const gp of (navigator.getGamepads?.()??[])) if(gp){
      mx+=Math.abs(gp.axes[0])>0.18?gp.axes[0]:0;
      mz+=Math.abs(gp.axes[1])>0.18?gp.axes[1]:0;
      lx+=Math.abs(gp.axes[2])>0.18?gp.axes[2]:0;
      ly+=Math.abs(gp.axes[3])>0.18?gp.axes[3]:0;
      A=A||gp.buttons[0]?.pressed; B=B||(gp.buttons[1]?.pressed||gp.buttons[5]?.pressed);
    }
    return {mx,mz,lx,ly,A,B};
  },
  consumeInteract(){const v=this.interact;this.interact=false;return v;},
  consumeFlash(){const v=this.flash;this.flash=false;return v;}
};

/* ============================ procedural textures ============================ */
// Tiny dithered tiles, periodic by construction (wrap-aware value noise) — the PS1 look.
function valueNoiseTile(size, period, seedFn){
  // periodic lattice noise: gradient grid wraps at `period`
  const grid=[]; for(let i=0;i<period*period;i++) grid.push(seedFn());
  const g=(x,y)=>grid[((y%period+period)%period)*period+((x%period+period)%period)];
  const smooth=t=>t*t*(3-2*t);
  const out=new Float32Array(size*size);
  for(let y=0;y<size;y++)for(let x=0;x<size;x++){
    const fx=x/size*period, fy=y/size*period;
    const x0=Math.floor(fx), y0=Math.floor(fy);
    const tx=smooth(fx-x0), ty=smooth(fy-y0);
    const a=lerp(g(x0,y0),g(x0+1,y0),tx), b=lerp(g(x0,y0+1),g(x0+1,y0+1),tx);
    out[y*size+x]=lerp(a,b,ty);
  }
  return out;
}
const BAYER=[0,8,2,10, 12,4,14,6, 3,11,1,9, 15,7,13,5];
function makeTileTex(size, painter, {filter=true}={}){
  const cv=document.createElement("canvas"); cv.width=cv.height=size;
  const ctx=cv.getContext("2d");
  painter(ctx,size);
  const t=new THREE.CanvasTexture(cv);
  t.wrapS=t.wrapT=THREE.RepeatWrapping;
  t.magFilter=THREE.NearestFilter;
  t.minFilter=filter?THREE.NearestMipmapLinearFilter:THREE.NearestFilter;
  t.colorSpace=THREE.SRGBColorSpace;
  return t;
}
function ditherFill(ctx,size,base,vary,noise,amp){
  const img=ctx.createImageData(size,size), d=img.data;
  for(let y=0;y<size;y++)for(let x=0;x<size;x++){
    const i=(y*size+x), n=noise?noise[i]:0.5;
    const dith=(BAYER[(y%4)*4+(x%4)]/16-0.5)*amp;
    const v=clamp(n+dith,0,1);
    d[i*4+0]=clamp(base[0]+vary[0]*(v-0.5)*2,0,255);
    d[i*4+1]=clamp(base[1]+vary[1]*(v-0.5)*2,0,255);
    d[i*4+2]=clamp(base[2]+vary[2]*(v-0.5)*2,0,255);
    d[i*4+3]=255;
  }
  ctx.putImageData(img,0,0);
}
const TEX={};
function buildTextures(){
  const S=64;
  TEX.dirt = makeTileTex(S,(c)=>{ // wet brown dirt with stones
    ditherFill(c,S,[86,68,52],[34,28,22],valueNoiseTile(S,8,rng),0.5);
    c.fillStyle="rgba(120,108,92,0.9)";
    for(let i=0;i<26;i++){const x=(rng()*S)|0,y=(rng()*S)|0;c.fillRect(x,y,1+(rng()*2|0),1);}
    c.fillStyle="rgba(40,32,26,0.8)";
    for(let i=0;i<18;i++){const x=(rng()*S)|0,y=(rng()*S)|0;c.fillRect(x,y,2,1);}
  });
  TEX.floor = makeTileTex(S,(c)=>{ // mossy forest floor + leaf litter
    ditherFill(c,S,[52,62,44],[22,26,18],valueNoiseTile(S,6,rng),0.5);
    c.fillStyle="rgba(96,82,48,0.85)";
    for(let i=0;i<30;i++){const x=(rng()*S)|0,y=(rng()*S)|0;c.fillRect(x,y,2,1);}
    c.fillStyle="rgba(34,44,30,0.9)";
    for(let i=0;i<22;i++){const x=(rng()*S)|0,y=(rng()*S)|0;c.fillRect(x,y,1,2);}
  });
  TEX.bark = makeTileTex(S,(c)=>{ // vertical striations — wraps because noise is periodic
    const n=valueNoiseTile(S,5,rng);
    const img=c.createImageData(S,S),d=img.data;
    for(let y=0;y<S;y++)for(let x=0;x<S;x++){
      const stripe=0.5+0.5*Math.sin(x/S*Math.PI*2*8 + n[y*S+x]*5);
      const dith=(BAYER[(y%4)*4+(x%4)]/16-0.5)*0.4;
      const v=clamp(stripe*0.7+n[y*S+x]*0.3+dith,0,1);
      d[(y*S+x)*4+0]=58+v*30; d[(y*S+x)*4+1]=48+v*26; d[(y*S+x)*4+2]=40+v*20; d[(y*S+x)*4+3]=255;
    }
    c.putImageData(img,0,0);
  });
  TEX.planks = makeTileTex(S,(c)=>{ // 4 plank rows — boundaries on exact divisions so edges wrap
    const n=valueNoiseTile(S,8,rng), img=c.createImageData(S,S), d=img.data;
    for(let y=0;y<S;y++)for(let x=0;x<S;x++){
      const row=(y/(S/4))|0, edge=(y%(S/4)===0)||((x+row*7)%S===0);
      const dith=(BAYER[(y%4)*4+(x%4)]/16-0.5)*0.45;
      const v=clamp(n[y*S+x]*0.6+0.2+0.5*Math.sin(x*0.6+row*9)*0.08+dith,0,1);
      let r=96+v*40,g=78+v*32,b=58+v*24;
      if(edge){r*=0.45;g*=0.45;b*=0.45;}
      d[(y*S+x)*4]=r;d[(y*S+x)*4+1]=g;d[(y*S+x)*4+2]=b;d[(y*S+x)*4+3]=255;
    }
    c.putImageData(img,0,0);
  });
  TEX.planksDark = makeTileTex(S,(c)=>{
    const n=valueNoiseTile(S,8,rng), img=c.createImageData(S,S), d=img.data;
    for(let y=0;y<S;y++)for(let x=0;x<S;x++){
      const row=(y/(S/4))|0, edge=(y%(S/4)===0)||((x+row*11)%S===0);
      const dith=(BAYER[(y%4)*4+(x%4)]/16-0.5)*0.45;
      const v=clamp(n[y*S+x]*0.6+0.2+dith,0,1);
      let r=70+v*26,g=60+v*22,b=48+v*18;
      if(edge){r*=0.4;g*=0.4;b*=0.4;}
      d[(y*S+x)*4]=r;d[(y*S+x)*4+1]=g;d[(y*S+x)*4+2]=b;d[(y*S+x)*4+3]=255;
    }
    c.putImageData(img,0,0);
  });
  TEX.metal = makeTileTex(S,(c)=>{ // corrugated roof — vertical ridges wrap (8 per tile)
    const img=c.createImageData(S,S),d=img.data, n=valueNoiseTile(S,4,rng);
    for(let y=0;y<S;y++)for(let x=0;x<S;x++){
      const ridge=0.5+0.5*Math.sin(x/S*Math.PI*2*8);
      const dith=(BAYER[(y%4)*4+(x%4)]/16-0.5)*0.3;
      const v=clamp(ridge*0.55+n[y*S+x]*0.35+dith,0,1);
      d[(y*S+x)*4]=70+v*34;d[(y*S+x)*4+1]=74+v*36;d[(y*S+x)*4+2]=76+v*36;d[(y*S+x)*4+3]=255;
    }
    c.putImageData(img,0,0);
  });
  // text canvases (signs / map) — not tiles
  TEX.sign = (lines,opts={})=>{
    const w=opts.w||256,h=opts.h||160;
    const cv=document.createElement("canvas");cv.width=w;cv.height=h;const c=cv.getContext("2d");
    c.fillStyle=opts.bg||"#8e8468";c.fillRect(0,0,w,h);
    c.strokeStyle="#4a4334";c.lineWidth=6;c.strokeRect(3,3,w-6,h-6);
    c.fillStyle=opts.fg||"#2c2820";c.font=`bold ${opts.size||16}px Courier New`;c.textAlign="center";
    lines.split("\n").forEach((ln,i)=>c.fillText(ln,w/2,(opts.top||34)+i*(opts.lh||20)));
    const t=new THREE.CanvasTexture(cv);t.magFilter=THREE.NearestFilter;t.colorSpace=THREE.SRGBColorSpace;
    return t;
  };
  TEX.wallMap = (()=>{
    const cv=document.createElement("canvas");cv.width=256;cv.height=192;const c=cv.getContext("2d");
    c.fillStyle="#b7ac8d";c.fillRect(0,0,256,192);
    c.strokeStyle="#5c5340";c.lineWidth=4;c.strokeRect(2,2,252,188);
    c.fillStyle="#9b8f72";for(let i=0;i<60;i++)c.fillRect((rng()*256)|0,(rng()*192)|0,2,2);
    // trails
    const trail=(pts,color,w)=>{c.strokeStyle=color;c.lineWidth=w;c.beginPath();
      c.moveTo(pts[0][0],pts[0][1]);for(const p of pts.slice(1))c.lineTo(p[0],p[1]);c.stroke();};
    trail([[20,170],[60,140],[90,150],[130,120],[170,124]], "#4f5d49",3);   // open trail
    trail([[20,170],[50,120],[70,90],[110,70]], "#4f5d49",3);
    trail([[110,70],[150,52],[200,40]], "#7a3a34",3);                       // trail 6
    trail([[130,120],[180,90],[214,96]], "#7a3a34",3);
    // crossed out
    const X=(x,y)=>{c.strokeStyle="#812620";c.lineWidth=3;
      c.beginPath();c.moveTo(x-8,y-8);c.lineTo(x+8,y+8);c.moveTo(x+8,y-8);c.lineTo(x-8,y+8);c.stroke();};
    X(160,46);X(196,92);X(70,90);
    c.fillStyle="#812620";c.font="bold 11px Courier New";c.textAlign="center";
    c.fillText("DO NOT RESTORE",128,26);
    c.fillText("OLD CONNECTORS",128,40);
    c.fillStyle="#3a342a";c.font="9px Courier New";
    c.fillText("SECTOR 4 — WITHDRAWN: 5, 6, 9",128,182);
    const t=new THREE.CanvasTexture(cv);t.magFilter=THREE.NearestFilter;t.colorSpace=THREE.SRGBColorSpace;
    return t;
  });
}

/* ============================ scene / renderer ============================ */
const Game = {
  state:"boot", // boot → start → play → reading → ended
  player:{x:1.6,y:1.62,z:18,yaw:Math.PI,pitch:0,vx:0,vz:0,bob:0,stepAcc:0},
  flashOn:false,
  hasMap:false,
  phase:"intro",
  tasks:{branches:0,branchesTotal:3,markers:0,markersTotal:3,shedSign:false,map:false,radio:false,
         erased:0,eraseTotal:6,inspected:0},
  dawnT:-1, dawnTotal:240, timecode:19.7*3600, // 7:42 PM
  ended:false,
};
let renderer, scene, camera, flashlight, flashTarget, hemi, moon, skyDome;
const colCircles=[]; // {x,z,r}
const colBoxes=[];   // {minx,maxx,minz,maxz}
const interactables=[]; // {x,z,y,r,type,prompt,active,use,node}
let trailheadSign, scenicSign, shedLight, shedGlow, figure;
const whiteMarkers=[], redMarkers=[], branches=[];

function initRenderer(){
  const canvas=$("c");
  renderer=new THREE.WebGLRenderer({canvas,antialias:false,powerPreference:"low-power"});
  renderer.setPixelRatio(Math.min(devicePixelRatio||1,1)*0.55); // low internal res = PS1 + perf
  renderer.setSize(innerWidth,innerHeight);
  scene=new THREE.Scene();
  scene.background=new THREE.Color(0x0a0d0f);
  scene.fog=new THREE.FogExp2(0x141a1c,0.060);
  // Dark gradient sky dome: near-black overhead, lightening only to the fog color
  // at the horizon, so the tops of the trees dissolve into darkness and you can't
  // read where the canopy ends.
  {
    const skyGeo=new THREE.SphereGeometry(150,24,12);
    const skyMat=new THREE.ShaderMaterial({
      side:THREE.BackSide, depthWrite:false, fog:false,
      uniforms:{ top:{value:new THREE.Color(0x020304)}, bottom:{value:new THREE.Color(0x141a1c)} },
      vertexShader:`varying float vy; void main(){ vy=normalize(position).y; gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0); }`,
      fragmentShader:`varying float vy; uniform vec3 top; uniform vec3 bottom;
        void main(){ float t=clamp(vy*2.4+0.02,0.0,1.0); t=pow(t,0.85); gl_FragColor=vec4(mix(bottom,top,t),1.0); }`
    });
    skyDome=new THREE.Mesh(skyGeo,skyMat);
    skyDome.renderOrder=-1;
    scene.add(skyDome);
  }
  camera=new THREE.PerspectiveCamera(70,innerWidth/innerHeight,0.1,160);
  hemi=new THREE.HemisphereLight(0x2c3a44,0x141009,0.55); scene.add(hemi);
  moon=new THREE.DirectionalLight(0x4a5666,0.22); moon.position.set(-20,40,-10); scene.add(moon);
  flashlight=new THREE.SpotLight(0xffe9bd,0,32,0.55,0.5,1.2);
  flashTarget=new THREE.Object3D();
  scene.add(flashlight); scene.add(flashTarget); flashlight.target=flashTarget;
  addEventListener("resize",()=>{ renderer.setSize(innerWidth,innerHeight);
    camera.aspect=innerWidth/innerHeight; camera.updateProjectionMatrix(); });
  // noise tile for the CSS grain overlay
  const ncv=document.createElement("canvas");ncv.width=ncv.height=128;
  const nc=ncv.getContext("2d"),img=nc.createImageData(128,128);
  for(let i=0;i<img.data.length;i+=4){const v=(Math.random()*255)|0;
    img.data[i]=v;img.data[i+1]=v;img.data[i+2]=v;img.data[i+3]=255;}
  nc.putImageData(img,0,0);
  $("noise").style.backgroundImage=`url(${ncv.toDataURL()})`;
}

/* ============================ world ============================ */
const PATH_PTS=[ [1.6,20],[0.8,14],[0,2],[-2.5,-14],[2,-32],[6,-52],[2.5,-72],[-3,-92],
                 [-1,-110],[0,-120],[1.5,-134],[4,-152],[5,-168],[2,-184],[0,-198] ];
let pathSamples=[];
function buildPathLookup(){
  const v=PATH_PTS.map(p=>new THREE.Vector3(p[0],0,p[1]));
  const curve=new THREE.CatmullRomCurve3(v);
  pathSamples=curve.getPoints(400);
  return curve;
}
function pathX(z){ // path is monotonic in z — interpolate
  const s=pathSamples;
  if(z>=s[0].z) return s[0].x;
  for(let i=1;i<s.length;i++) if(s[i].z<=z){
    const a=s[i-1],b=s[i],t=(z-a.z)/(b.z-a.z||1e-6);
    return lerp(a.x,b.x,t);
  }
  return s[s.length-1].x;
}
function distToPath(x,z){
  let best=1e9;
  for(let i=0;i<pathSamples.length;i+=2){
    const dx=x-pathSamples[i].x,dz=z-pathSamples[i].z;
    const d=dx*dx+dz*dz; if(d<best)best=d;
  }
  return Math.sqrt(best);
}
function addCircle(x,z,r){colCircles.push({x,z,r});}
function addBoxCol(cx,cz,w,d,ry=0){
  if(Math.abs(ry)%Math.PI>0.01 && Math.abs(Math.abs(ry)%Math.PI-Math.PI/2)>0.01){} // axis-aligned only
  const W=(Math.abs(ry%Math.PI)>0.7)?d:w, D=(Math.abs(ry%Math.PI)>0.7)?w:d;
  colBoxes.push({minx:cx-W/2,maxx:cx+W/2,minz:cz-D/2,maxz:cz+D/2});
}
function addInteract(o){ o.active=o.active??true; interactables.push(o); return o; }

const MATS={};
function buildMaterials(){
  const TL=new THREE.TextureLoader();
  const load=(p,rep)=>{ const t=TL.load(p); t.wrapS=t.wrapT=THREE.RepeatWrapping; t.colorSpace=THREE.SRGBColorSpace; if(rep)t.repeat.set(rep[0],rep[1]); return t; };
  const loadN=(p,rep)=>{ const t=TL.load(p); t.wrapS=t.wrapT=THREE.RepeatWrapping; if(rep)t.repeat.set(rep[0],rep[1]); return t; };
  // realistic mossy forest floor with normal-mapped relief (catches the flashlight)
  const flMap=load("./assets/textures/ground_floor.png",[90,90]);
  const flNrm=loadN("./assets/textures/ground_floor_n.png",[90,90]);
  MATS.floor=new THREE.MeshStandardMaterial({map:flMap,normalMap:flNrm,
    normalScale:new THREE.Vector2(1.2,1.2),roughness:0.97,metalness:0.0,color:0xa8a8a8});
  // packed trail dirt — tiling density matched to the floor so it doesn't smear
  const dMap=load("./assets/textures/ground_dirt.png",[1,1]);
  const dNrm=loadN("./assets/textures/ground_dirt_n.png",[1,1]);
  MATS.dirt=new THREE.MeshStandardMaterial({map:dMap,normalMap:dNrm,
    normalScale:new THREE.Vector2(1.2,1.2),roughness:0.97,metalness:0.0,color:0xa8a8a8});
  // gravel parking lot — same PBR system + normal map so it matches the rest
  const gMap=load("./assets/textures/ground_gravel.png",[10,7]);
  const gNrm=loadN("./assets/textures/ground_gravel_n.png",[10,7]);
  MATS.gravel=new THREE.MeshStandardMaterial({map:gMap,normalMap:gNrm,
    normalScale:new THREE.Vector2(1.2,1.2),roughness:0.97,metalness:0.0,color:0xa8a8a8});
  MATS.bark=new THREE.MeshLambertMaterial({map:TEX.bark});
  MATS.canopy=new THREE.MeshLambertMaterial({color:0x27392a,flatShading:true});
  MATS.canopy2=new THREE.MeshLambertMaterial({color:0x1f3024,flatShading:true});
  MATS.planks=new THREE.MeshLambertMaterial({map:TEX.planks});
  MATS.planksDark=new THREE.MeshLambertMaterial({map:TEX.planksDark});
  MATS.metal=new THREE.MeshLambertMaterial({map:TEX.metal});
  MATS.wood=new THREE.MeshLambertMaterial({color:0x6e5a42,flatShading:true});
  MATS.woodDark=new THREE.MeshLambertMaterial({color:0x4a3c2c,flatShading:true});
  MATS.rock=new THREE.MeshLambertMaterial({color:0x596066,flatShading:true});
  MATS.markerFaded=new THREE.MeshBasicMaterial({color:0x8d8d7c});
  MATS.markerWhite=new THREE.MeshBasicMaterial({color:0xeeeede});
  MATS.markerRed=new THREE.MeshBasicMaterial({color:0xc01f14});
  MATS.dark=new THREE.MeshBasicMaterial({color:0x07090a});
  MATS.paper=new THREE.MeshLambertMaterial({color:0xcfc6ae});
  MATS.can=new THREE.MeshLambertMaterial({color:0x8a3026,flatShading:true});
  MATS.water=new THREE.MeshLambertMaterial({color:0x10181c});
}
function box(w,h,d,mat,x,y,z,ry=0,collide=false,invisible=false){
  const m=new THREE.Mesh(new THREE.BoxGeometry(w,h,d),mat);
  m.position.set(x,y,z); m.rotation.y=ry; m.visible=!invisible; scene.add(m);
  if(collide) addBoxCol(x,z,w+0.25,d+0.25,ry);
  return m;
}
function plane(w,h,mat,x,y,z,ry=0,rx=0){
  const m=new THREE.Mesh(new THREE.PlaneGeometry(w,h),mat);
  m.position.set(x,y,z); m.rotation.set(rx,ry,0); scene.add(m); return m;
}

function buildGroundAndPath(curve){
  const g=new THREE.Mesh(new THREE.PlaneGeometry(360,360),MATS.floor);
  g.rotation.x=-Math.PI/2; g.position.set(0,-0.02,-95); scene.add(g);
  // trail ribbon along curve
  const N=240, w=1.35, pos=[],uv=[],idx=[];
  const pts=curve.getPoints(N);
  let runLen=0;
  for(let i=0;i<=N;i++){
    const p=pts[Math.min(i,N-1)];
    const q=pts[Math.min(i+1,N-1)];
    let tx=q.x-p.x,tz=q.z-p.z;const tl=Math.hypot(tx,tz)||1;tx/=tl;tz/=tl;
    const nx=-tz,nz=tx;
    pos.push(p.x+nx*w,0.015,p.z+nz*w, p.x-nx*w,0.015,p.z-nz*w);
    // UVs in real-world units (~1 tile per 4m) so the dirt matches the floor's
    // texel density instead of stretching along the ribbon
    if(i>0){ const pp=pts[Math.min(i-1,N-1)]; runLen+=Math.hypot(p.x-pp.x,p.z-pp.z); }
    const vrun=runLen/4.0, urep=(w*2)/4.0;
    uv.push(0,vrun, urep,vrun);
    if(i<N){const a=i*2;idx.push(a,a+1,a+2, a+1,a+3,a+2);}
  }
  const geo=new THREE.BufferGeometry();
  geo.setAttribute("position",new THREE.Float32BufferAttribute(pos,3));
  geo.setAttribute("uv",new THREE.Float32BufferAttribute(uv,2));
  geo.setIndex(idx); geo.computeVertexNormals();
  scene.add(new THREE.Mesh(geo,MATS.dirt));
  // creek
  const creek=plane(120,4.4,MATS.water,0,0.005,-120,0,-Math.PI/2);
  creek.rotation.z=0.04;
}
// Holds loaded realistic tree variants [{geometry,material,unitH}], may be empty.
let TREE_GLBS=[];
const TREE_FILES=["pine_tree.glb","spruce_tree.glb","fir_tree.glb"];
async function loadTreeMesh(){
  const loader=new GLTFLoader();
  const out=[];
  for(const fn of TREE_FILES){
    try{
      const gltf=await new Promise((res,rej)=>loader.load("./assets/models/"+fn,res,undefined,rej));
      let geo=null, mat=null;
      gltf.scene.updateWorldMatrix(true,true);
      gltf.scene.traverse(o=>{ if(o.isMesh && !geo){ geo=o.geometry.clone(); geo.applyMatrix4(o.matrixWorld); mat=o.material; }});
      if(!geo) continue;
      geo.computeBoundingBox();
      const bb=geo.boundingBox, h=bb.max.y-bb.min.y;
      geo.translate(0,-bb.min.y,0);
      if(mat){ mat.fog=true; mat.roughness=1.0; mat.metalness=0.0; mat.side=THREE.FrontSide; }
      out.push({geometry:geo, material:mat, unitH:h});
    }catch(e){ console.warn("tree mesh load failed",fn,e); }
  }
  TREE_GLBS=out;
}

// ---- building meshes (GLB) ----
const BUILDING_GLB={};
async function loadBuildingMeshes(){
  const files={shed:"shed.glb", outpost:"outpost.glb", cabin:"cabin.glb", signpost:"signpost.glb",
    // bespoke abandoned cabins — generate these in Codex and drop the .glb files in;
    // they load automatically. Until then the clearing reuses cabin/shed meshes.
    cabin_abandoned_1:"cabin_abandoned_1.glb", cabin_abandoned_2:"cabin_abandoned_2.glb",
    cabin_abandoned_3:"cabin_abandoned_3.glb", cabin_abandoned_4:"cabin_abandoned_4.glb"};
  const loader=new GLTFLoader();
  for(const [name,fn] of Object.entries(files)){
    try{
      const gltf=await new Promise((res,rej)=>loader.load("./assets/models/"+fn,res,undefined,rej));
      const root=gltf.scene;
      root.updateWorldMatrix(true,true);
      const bb=new THREE.Box3().setFromObject(root);
      const dims={w:bb.max.x-bb.min.x, h:bb.max.y-bb.min.y, d:bb.max.z-bb.min.z};
      root.traverse(o=>{ if(o.isMesh && o.material){ o.material.fog=true; if('roughness'in o.material){o.material.roughness=1.0;o.material.metalness=0.05;} o.material.side=THREE.FrontSide; }});
      BUILDING_GLB[name]={root, dims};
    }catch(e){ console.warn("building mesh load failed",name,e); }
  }
}
// Place a loaded building GLB: scale so width≈targetW, seat base on ground at
// (x,z), rotate ry. Returns the group, or null if missing (keep procedural shell).
function placeBuilding(name,x,z,ry,targetW){
  const b=BUILDING_GLB[name];
  if(!b) return null;
  const g=b.root.clone(true);
  const k=targetW/(b.dims.w||1);
  g.scale.setScalar(k);
  g.rotation.y=ry;
  g.updateWorldMatrix(true,true);
  const bb=new THREE.Box3().setFromObject(g);
  g.position.set(x, -bb.min.y, z);
  scene.add(g);
  return g;
}

// ---- bush / undergrowth meshes (GLB), instanced scatter ----
let BUSH_GLBS=[];
const BUSH_FILES=["bush_shrub.glb","bush_fern.glb"];
async function loadBushMesh(){
  const loader=new GLTFLoader();
  const out=[];
  for(const fn of BUSH_FILES){
    try{
      const gltf=await new Promise((res,rej)=>loader.load("./assets/models/"+fn,res,undefined,rej));
      let geo=null,mat=null;
      gltf.scene.updateWorldMatrix(true,true);
      gltf.scene.traverse(o=>{ if(o.isMesh && !geo){ geo=o.geometry.clone(); geo.applyMatrix4(o.matrixWorld); mat=o.material; }});
      if(!geo) continue;
      geo.computeBoundingBox();
      const bb=geo.boundingBox, h=bb.max.y-bb.min.y;
      geo.translate(0,-bb.min.y,0);
      if(mat){ mat.fog=true; if('roughness'in mat){mat.roughness=1.0;mat.metalness=0.0;} mat.side=THREE.DoubleSide; }
      out.push({geometry:geo, material:mat, unitH:h});
    }catch(e){ console.warn("bush mesh load failed",fn,e); }
  }
  BUSH_GLBS=out;
}

// ---- fallen log mesh (GLB), used for the blocking branches on the path ----
let LOG_GLB=null;
async function loadLogMesh(){
  try{
    const gltf=await new Promise((res,rej)=>new GLTFLoader().load("./assets/models/fallen_log.glb",res,undefined,rej));
    let geo=null,mat=null;
    gltf.scene.updateWorldMatrix(true,true);
    gltf.scene.traverse(o=>{ if(o.isMesh && !geo){ geo=o.geometry.clone(); geo.applyMatrix4(o.matrixWorld); mat=o.material; }});
    if(!geo) return;
    geo.computeBoundingBox();
    const bb=geo.boundingBox;
    // center the geometry on its own bbox so it rotates about its long axis cleanly
    const cx=(bb.max.x+bb.min.x)/2, cy=(bb.max.y+bb.min.y)/2, cz=(bb.max.z+bb.min.z)/2;
    geo.translate(-cx,-cy,-cz);
    const dims={x:bb.max.x-bb.min.x, y:bb.max.y-bb.min.y, z:bb.max.z-bb.min.z};
    // longest axis = the log's length
    const longest=Math.max(dims.x,dims.y,dims.z);
    if(mat){ mat.fog=true; if('roughness'in mat){mat.roughness=1.0;mat.metalness=0.0;} mat.side=THREE.FrontSide; }
    LOG_GLB={geometry:geo, material:mat, longest, dims};
  }catch(e){ console.warn("log mesh load failed",e); LOG_GLB=null; }
}

// Scatter bushes with an INVERTED density gradient: sparse but encroaching near
// the trail (a few creep to ~3m for an overgrown look), thickening outward toward
// the treeline. Keyed to distance from path so the open walking line guides you.
function buildBushes(){
  if(!BUSH_GLBS.length) return;
  const M=new THREE.Matrix4(),Q=new THREE.Quaternion(),S=new THREE.Vector3(),P=new THREE.Vector3();
  const TARGET_H=0.85;                 // bushes ~0.85m tall
  const FAR=46;
  const buckets=BUSH_GLBS.map(()=>[]);
  let placed=0,guard=0,want=900;
  while(placed<want && guard++<24000){
    const z=R(-206,14);
    const px=pathX(z);
    const side=rng()<0.5?-1:1;
    const x=px+side*R(2.2,FAR);
    const d=distToPath(x,z);
    if(d<2.2 || d>FAR) continue;
    // density gradient: near the path keep it sparse (overgrown encroachment only),
    // ramp up with distance. prob 0 at d=2.2 → ~1 by d~22.
    const t=clamp((d-2.2)/20, 0, 1);
    const prob = 0.10 + 0.90*t*t;       // quadratic ramp; ~10% chance right at edge
    if(rng()>prob) continue;
    // building pad exclusions (same as trees)
    if(x>px+3 && z<-86 && z>-100) continue;
    if(x<px-2 && z<-160 && z>-178) continue;
    if(Math.abs(z+120)<4) continue;
    if(z>7 && Math.abs(x-pathX(z))<14) continue;        // parking lot clearing
    const vi=Math.floor(rng()*BUSH_GLBS.length);
    const s=R(0.7,1.5), rot=rng()*6.28;
    buckets[vi].push({x,z,s,rot});
    placed++;
  }
  BUSH_GLBS.forEach((glb,vi)=>{
    const mine=buckets[vi];
    if(!mine.length) return;
    const k=TARGET_H/(glb.unitH||1);
    const inst=new THREE.InstancedMesh(glb.geometry,glb.material,mine.length);
    inst.frustumCulled=true;
    mine.forEach((b,i)=>{
      P.set(b.x,0,b.z); Q.setFromEuler(new THREE.Euler(0,b.rot,0));
      const sc=k*b.s; S.set(sc,sc*R(0.9,1.15),sc);
      M.compose(P,Q,S); inst.setMatrixAt(i,M);
    });
    inst.instanceMatrix.needsUpdate=true;
    scene.add(inst);
  });
}

// Dense grass tufts scattered across the walkable area — crossed billboard planes
// (two intersecting quads so each tuft reads as 3D from any angle), instanced for
// performance. Denser near the path so the trail edge feels lush and overgrown.
function buildGrass(){
  const tex=new THREE.TextureLoader().load("./assets/textures/grass_tuft.png");
  tex.colorSpace=THREE.SRGBColorSpace;
  const mat=new THREE.MeshLambertMaterial({map:tex,transparent:true,alphaTest:0.4,
    side:THREE.DoubleSide,depthWrite:true,fog:true});
  // one tuft = two crossed quads merged into a single geometry
  const q1=new THREE.PlaneGeometry(0.7,0.5); q1.translate(0,0.25,0);
  const q2=q1.clone(); q2.rotateY(Math.PI/2);
  const tuft=mergeGeometries([q1,q2]);
  const N=4200;
  const inst=new THREE.InstancedMesh(tuft,mat,N);
  inst.frustumCulled=true;
  const M=new THREE.Matrix4(),Q=new THREE.Quaternion(),S=new THREE.Vector3(),P=new THREE.Vector3();
  let placed=0,guard=0;
  while(placed<N && guard++<40000){
    const z=R(-206,20);
    const px=pathX(z);
    const side=rng()<0.5?-1:1;
    // bias toward the path: most grass within ~12m, some out to 40
    const dist = rng()<0.7 ? R(1.0,12) : R(12,40);
    const x=px+side*dist;
    const d=distToPath(x,z);
    if(d<1.4 || d>42) continue;
    if(z>6 && Math.abs(x-pathX(z))<12) continue;   // keep gravel lot mostly clear
    const s=R(0.7,1.5);
    P.set(x,0,z); Q.setFromEuler(new THREE.Euler(0,rng()*6.28,0)); S.set(s,s*R(0.8,1.3),s);
    M.compose(P,Q,S); inst.setMatrixAt(placed,M);
    placed++;
  }
  inst.count=placed; inst.instanceMatrix.needsUpdate=true;
  scene.add(inst);
}

function buildTrees(){
  const M=new THREE.Matrix4(),Q=new THREE.Quaternion(),S=new THREE.Vector3(),P=new THREE.Vector3();
  const treePos=[];

  // ---- NEAR BAND: real 3D trees, filling out to near the backdrop box ----
  const NEAR=44;            // trees out to just shy of the wall at 50
  const slots=[];
  const useGLB = TREE_GLBS.length>0;
  // Even coverage: walk the trail in fixed z-slices and fill each slice to the same
  // target density, so every stretch (including the entrance) is equally dense
  // instead of relying on random sampling that leaves clumps and gaps.
  const zStart=12, zEnd=-206, slice=4;
  // Density biased toward the path: a dense inner wall of trees lines the trail to
  // guide the player forward, thinning out toward the far treeline.
  const innerPerSide = useGLB ? 8 : 3;   // tight band hugging the path (3.6–15)
  const outerPerSide = useGLB ? 5 : 1;   // looser fill behind it (15–44)
  for(let z0=zStart; z0>zEnd; z0-=slice){
    for(const side of [-1,1]){
      const place=(rMin,rMax,count)=>{
        let put=0, tries=0;
        while(put<count && tries++<70){
          const z=z0-rng()*slice;
          const px=pathX(z);
          const x=px+side*R(rMin,rMax);
          const d=distToPath(x,z);
          if(d<3.2 || d>NEAR) continue;
          if(x>px+3 && z<-86 && z>-100) continue;            // shed pad
          if(x<px-2 && z<-160 && z>-178) continue;           // outpost pad
          if(Math.abs(z+120)<4) continue;                    // creek
          if(Math.abs(z+140)<6 && x>px+14 && x<px+30) continue; // distant cabin pad
          if(z>6 && Math.abs(x-pathX(z))<13) continue;       // parking lot clearing
          const s=R(0.85,1.5);
          const rot=rng()*6.28;
          const variant = useGLB ? (Math.floor(rng()*TREE_GLBS.length)) : 0;
          slots.push({x,z,s,rot,variant});
          if(d<11) addCircle(x,z,0.5*s);
          treePos.push({x,z,s});
          put++;
        }
      };
      place(3.6,15,innerPerSide);   // dense corridor wall
      place(15,NEAR,outerPerSide);  // thinning far fill
    }
  }

  // DENSE entrance ring: pack trees tightly around the parking lot so the area you
  // spawn in and walk through is walled by thick forest, while the gravel lot stays
  // open. Lot spans x≈[-13,16], z≈[5,23]; trail mouth around z≈2..9.
  if(useGLB){
    const ring=[];
    for(let z=24; z>=0; z-=2.2){
      for(const [bx,bw] of [[-15,-1],[18,1]]){    // just outside each lot edge
        for(let r=0;r<2;r++){
          ring.push({x: bx + bw*r*R(2.6,4.2) + R(-1.2,1.2), z: z+R(-1,1)});
        }
      }
    }
    for(let x=-22; x<=24; x+=2.4) ring.push({x:x+R(-1,1), z:R(24.5,29.5)});
    for(let z=9; z>=2; z-=1.6){
      ring.push({x:pathX(z)-R(7,11), z});
      ring.push({x:pathX(z)+R(7,11), z});
    }
    for(const p of ring){
      const s=R(0.9,1.5), rot=rng()*6.28;
      const variant=Math.floor(rng()*TREE_GLBS.length);
      slots.push({x:p.x, z:p.z, s, rot, variant});
      treePos.push({x:p.x, z:p.z, s});
    }
  }

  if(TREE_GLBS.length){
    const TARGET_H=7.0;
    // one InstancedMesh per variant
    TREE_GLBS.forEach((glb,vi)=>{
      const mine=slots.filter(t=>t.variant===vi);
      if(!mine.length) return;
      const k=TARGET_H/(glb.unitH||1);
      const inst=new THREE.InstancedMesh(glb.geometry,glb.material,mine.length);
      inst.frustumCulled=true;
      mine.forEach((t,i)=>{
        P.set(t.x,0,t.z); Q.setFromEuler(new THREE.Euler(0,t.rot,0));
        const sc=k*t.s; S.set(sc,sc,sc);
        M.compose(P,Q,S); inst.setMatrixAt(i,M);
      });
      inst.instanceMatrix.needsUpdate=true;
      scene.add(inst);
    });
    buildForestBackdrop();   // painted dense forest beyond the near band
    return treePos;
  }

  // ---- procedural fallback (original low-poly trees) ----
  const trunkG=new THREE.CylinderGeometry(0.26,0.42,3.6,5);
  const coneG=new THREE.ConeGeometry(1.5,2.6,6);
  const trunks=new THREE.InstancedMesh(trunkG,MATS.bark,slots.length);
  const conesA=new THREE.InstancedMesh(coneG,MATS.canopy,slots.length);
  const conesB=new THREE.InstancedMesh(coneG,MATS.canopy2,slots.length);
  slots.forEach((t,i)=>{
    const s=t.s;
    P.set(t.x,1.8*s,t.z); Q.setFromEuler(new THREE.Euler(0,t.rot,0)); S.set(s,s,s);
    M.compose(P,Q,S); trunks.setMatrixAt(i,M);
    P.set(t.x,3.4*s,t.z); S.set(s*1.06,s,s*1.06); M.compose(P,Q,S); conesA.setMatrixAt(i,M);
    P.set(t.x,4.6*s,t.z); S.set(s*0.78,s*0.9,s*0.78); M.compose(P,Q,S); conesB.setMatrixAt(i,M);
  });
  scene.add(trunks,conesA,conesB);
  return treePos;
}

// Closed rectangular forest BOX enclosing the whole playable world. Four straight
// walls that overlap at the corners (no gaps), with the base sunk BELOW the ground
// plane so the grass overlaps the wall foot — no hard seam line where wall meets
// ground. Set well beyond the player's soft bounds (±34) so you never reach it.
let backdropCards=[];
function buildForestBackdrop(){
  const tex=new THREE.TextureLoader().load("./assets/textures/forest_backdrop.png");
  tex.colorSpace=THREE.SRGBColorSpace;
  tex.wrapS=THREE.RepeatWrapping; tex.wrapT=THREE.ClampToEdgeWrapping;
  const mat=new THREE.MeshBasicMaterial({map:tex,transparent:true,depthWrite:false,
    color:0x3a4640,fog:true,side:THREE.BackSide,alphaTest:0.0});
  backdropCards=[];
  // Rectangle bounds: trail x ranges roughly -3..+6 and bends; pad generously so
  // the box clears all trees (which reach ~44 from a bending centerline).
  const minX=-58, maxX=58, minZ=-214, maxZ=32;
  const Hwall=26, baseY=-4;           // base sunk 4m below ground; tall enough to fill view
  const cx=(minX+maxX)/2, cz=(minZ+maxZ)/2;
  const wX=maxX-minX, wZ=maxZ-minZ;
  function wall(w, x, z, ry){
    const geo=new THREE.PlaneGeometry(w*1.02, Hwall);
    const reps=Math.max(1,Math.round(w/16));
    const uv=geo.attributes.uv.array;
    for(let i=0;i<uv.length;i+=2) uv[i]*=reps;     // tile horizontally, no stretch
    geo.attributes.uv.needsUpdate=true;
    const m=new THREE.Mesh(geo,mat);
    m.position.set(x, baseY+Hwall/2, z);
    m.rotation.y=ry;
    scene.add(m); backdropCards.push(m);
  }
  // BackSide material means each wall shows its forest from inside the box.
  wall(wX, cx, maxZ, 0);            // north (far -z is min; this is +z end behind start)
  wall(wX, cx, minZ, Math.PI);     // south
  wall(wZ, minX, cz, Math.PI/2);   // west
  wall(wZ, maxX, cz, -Math.PI/2);  // east
  // Ground "apron": a dark ring plane just inside the walls, tinted to the wall
  // base color, so even if fog thins the transition reads as forest floor, not a line.
  const apron=new THREE.Mesh(new THREE.RingGeometry(40,80,4,1),
    new THREE.MeshBasicMaterial({color:0x1a221c,fog:true,side:THREE.DoubleSide,transparent:true,opacity:0.85}));
  apron.rotation.x=-Math.PI/2; apron.rotation.z=Math.PI/4;
  apron.position.set(cx,-0.015,cz); scene.add(apron);
}
function makeMarkerPlane(mat){
  return new THREE.Mesh(new THREE.PlaneGeometry(0.3,0.46),mat.clone());
}
function markerOnTree(tree,facePathZ,mat,yOverride){
  const px=pathX(tree.z);
  const dirx=px-tree.x, dirz=facePathZ-tree.z;
  const yaw=Math.atan2(dirx,dirz||0.001);
  const m=makeMarkerPlane(mat);
  // GLB trunks are much wider at the base than the procedural ones; push the
  // marker out to the bark surface so it doesn't sink into the mesh.
  const off = TREE_GLBS.length ? (0.55*tree.s+0.12) : (0.46*tree.s+0.03);
  m.position.set(tree.x+Math.sin(yaw)*off, yOverride??1.55, tree.z+Math.cos(yaw)*off);
  m.rotation.y=yaw;
  scene.add(m); return m;
}
function nearestTree(trees,x,z,minD=0,maxD=9,sidePref=0){
  let best=null,bd=1e9;
  for(const t of trees){
    const d=Math.hypot(t.x-x,t.z-z);
    if(d<minD||d>maxD) continue;
    if(sidePref!==0 && Math.sign(t.x-pathX(t.z))!==sidePref) continue;
    if(d<bd){bd=d;best=t;}
  }
  return best;
}

/* ---------- structures: shed, outpost, bridge, cabin, trailhead ---------- */
function buildShed(){
  const px=pathX(-92), x=px+6.8, z=-92, ry=Math.PI/2; // door faces the path (west)
  const W=4,D=3.2,H=2.5;
  const useGLB = placeBuilding("shed",x,z,ry,W+0.7);
  if(!useGLB){
    box(W,0.18,D,MATS.woodDark,x,0.09,z);                                  // slab
    box(0.12,H,D,MATS.planks,x+W/2,H/2+0.18,z,0,true);                     // back
    box(W,H,0.12,MATS.planks,x,H/2+0.18,z-D/2,0,true);                     // side
    box(W,H,0.12,MATS.planks,x,H/2+0.18,z+D/2,0,true);                     // side
    box(0.12,H,(D-1.0)/2,MATS.planks,x-W/2,H/2+0.18,z-D/2+(D-1.0)/4,0,true);
    box(0.12,H,(D-1.0)/2,MATS.planks,x-W/2,H/2+0.18,z+D/2-(D-1.0)/4,0,true);
    box(0.12,0.6,1.0,MATS.planks,x-W/2,H+0.18-0.3,z);                      // lintel
    box(0.06,H-0.7,0.95,MATS.planksDark,x-W/2-0.45,(H-0.7)/2+0.18,z-0.75,0.9); // door
    const r1=box(W+0.7,0.1,D*0.62,MATS.metal,x,H+0.62,z-D*0.26); r1.rotation.x=0.5;
    const r2=box(W+0.7,0.1,D*0.62,MATS.metal,x,H+0.62,z+D*0.26); r2.rotation.x=-0.5;
    box(W+0.7,0.12,0.16,MATS.woodDark,x,H+1.02,z);
    box(0.06,0.7,0.7,MATS.dark,x-W/2-0.01,1.6,z+0.95);                     // window frame
    // interior dressing (procedural only)
    box(1.6,0.9,0.4,MATS.woodDark,x+1,0.63,z-1.2);
    const can=(cx,cz)=>{const m=new THREE.Mesh(new THREE.CylinderGeometry(0.16,0.16,0.42,6),MATS.can);
      m.position.set(cx,0.39,cz);scene.add(m);};
    can(x+0.8,z-1.15);can(x+1.25,z-1.25);
    box(0.5,0.5,0.5,MATS.wood,x+1.3,0.43,z+1.0,0.3);
    box(0.07,1.4,0.07,MATS.woodDark,x-0.4,0.9,z+1.3,0.5);
    box(0.07,1.3,0.07,MATS.woodDark,x-0.25,0.85,z+1.32,-0.4);
  } else {
    // GLB shell in place — add invisible colliders matching the footprint so you
    // can't walk through walls, and leave a door gap on the path-facing (west) side.
    box(0.12,H,D,MATS.planks,x+W/2,H/2+0.18,z,0,true,true);                // back
    box(W,H,0.12,MATS.planks,x,H/2+0.18,z-D/2,0,true,true);               // side
    box(W,H,0.12,MATS.planks,x,H/2+0.18,z+D/2,0,true,true);               // side
    box(0.12,H,(D-1.0)/2,MATS.planks,x-W/2,H/2+0.18,z-D/2+(D-1.0)/4,0,true,true);
    box(0.12,H,(D-1.0)/2,MATS.planks,x-W/2,H/2+0.18,z+D/2-(D-1.0)/4,0,true,true);
  }
  // window glow plane + light (the "shed light turns on behind you" event) — kept regardless
  shedGlow=plane(0.62,0.62,new THREE.MeshBasicMaterial({color:0xd8b36a}),x-W/2-0.04,1.6,z+0.95,-Math.PI/2);
  shedGlow.visible=false;
  shedLight=new THREE.PointLight(0xd8b36a,0,9); shedLight.position.set(x,1.8,z); scene.add(shedLight);
  // hidden posted notice on the inside back wall
  const sgn=plane(0.8,0.6,new THREE.MeshLambertMaterial({map:TEX.sign("TRAIL CLOSED\nDO NOT\nRESTORE",{w:160,h:120,size:16,top:34,lh:26,bg:"#b7ac8d",fg:"#7a2620"})}),
    x+W/2-0.08,1.5,z, -Math.PI/2);
  addInteract({x:x+W/2-0.4,z,y:1.5,r:2.0,type:"read",prompt:STR.pRead,text:STR.noteShed,
    use(){ Game.tasks.shedSign=true; Events.fire("shedSign"); }});
  Triggers.push({x,z,r:3.2,once:true,fn(){ AudioSys.staticBurst(0.16,1.0); UI.glitch(); }});
  return {x,z};
}
function buildOutpost(){
  const px=pathX(-168), x=px-7.5, z=-168;
  const W=6,D=4.6,H=2.7;
  const useGLB = placeBuilding("outpost",x,z,-Math.PI/2,W+1.6);
  if(!useGLB){
    box(W+1.6,0.22,D+2.6,MATS.woodDark,x,0.11,z);                           // raised slab + porch
    const post=(pz)=>box(0.14,2.2,0.14,MATS.woodDark,x+W/2+1.0,1.21,z+pz,0,true);
    post(-D/2-0.2);post(D/2+0.2);post(-0.7);post(0.7);
    const pr=box(2.0,0.08,D+2.6,MATS.metal,x+W/2+0.45,2.45,z); pr.rotation.z=0.18;
    box(0.14,H,D,MATS.planksDark,x-W/2,H/2+0.22,z,0,true);                  // back
    box(W,H,0.14,MATS.planksDark,x,H/2+0.22,z-D/2,0,true);
    box(W,H,0.14,MATS.planksDark,x,H/2+0.22,z+D/2,0,true);
    box(0.14,H,(D-1.05)/2,MATS.planksDark,x+W/2,H/2+0.22,z-D/2+(D-1.05)/4,0,true);
    box(0.14,H,(D-1.05)/2,MATS.planksDark,x+W/2,H/2+0.22,z+D/2-(D-1.05)/4,0,true);
    box(0.14,0.7,1.05,MATS.planksDark,x+W/2,H-0.13+0.22,z);
    box(0.06,H-0.75,0.98,MATS.planks,x+W/2+0.5,(H-0.75)/2+0.22,z+0.78,-1.1); // door
    box(0.06,0.8,0.9,MATS.dark,x+W/2+0.01,1.7,z-1.5);
    box(0.06,0.8,0.9,MATS.dark,x-W/2-0.01,1.7,z+1.2);
    const r1=box(W*0.62,0.1,D+1.0,MATS.metal,x-W*0.26,H+0.7,z); r1.rotation.z=-0.5;
    const r2=box(W*0.62,0.1,D+1.0,MATS.metal,x+W*0.26,H+0.7,z); r2.rotation.z=0.5;
    box(0.16,0.12,D+1.0,MATS.woodDark,x,H+1.15,z);
  } else {
    // invisible wall colliders with the path-facing (+x) door gap
    box(0.14,H,D,MATS.planksDark,x-W/2,H/2+0.22,z,0,true,true);             // back
    box(W,H,0.14,MATS.planksDark,x,H/2+0.22,z-D/2,0,true,true);
    box(W,H,0.14,MATS.planksDark,x,H/2+0.22,z+D/2,0,true,true);
    box(0.14,H,(D-1.05)/2,MATS.planksDark,x+W/2,H/2+0.22,z-D/2+(D-1.05)/4,0,true,true);
    box(0.14,H,(D-1.05)/2,MATS.planksDark,x+W/2,H/2+0.22,z+D/2-(D-1.05)/4,0,true,true);
  }
  // ---- interior (kept regardless — these are what the player interacts with) ----
  const bulb=new THREE.PointLight(0xc7a86a,0.5,7.5); bulb.position.set(x,2.2,z); scene.add(bulb);
  Game.bulb=bulb;
  box(1.8,0.08,0.8,MATS.wood,x-1.6,0.95,z-1.2,0,true);
  box(0.08,0.9,0.7,MATS.wood,x-2.4,0.55,z-1.2); box(0.08,0.9,0.7,MATS.wood,x-0.85,0.55,z-1.2);
  box(0.45,0.5,0.45,MATS.woodDark,x-1.0,0.45,z-0.3,0.4);                  // chair
  const radio=box(0.5,0.3,0.3,MATS.dark,x-2.0,1.14,z-1.25,0.1);
  plane(0.16,0.06,new THREE.MeshBasicMaterial({color:0x202824}),x-2.0,1.18,z-1.09,0.1);
  box(0.02,0.5,0.02,MATS.dark,x-2.18,1.5,z-1.3);                          // antenna
  addInteract({x:x-2.0,z:z-1.0,y:1.1,r:1.8,type:"radio",prompt:STR.pRadio,
    use(){ if(!Game.tasks.radio){ Game.tasks.radio=true; Events.fire("radioChecked"); }
           else UI.read(STR.noteRadioDead); }});
  plane(0.3,0.4,MATS.paper,x-1.3,1.0,z-1.1,0.2,-Math.PI/2+0.06);
  addInteract({x:x-1.3,z:z-1.1,y:1.0,r:1.6,type:"read",prompt:STR.pRead,text:STR.noteDesk,use(){}});
  // a folded PARK MAP on the desk — pick it up and it becomes a live minimap in
  // the bottom-left that you follow.
  const mapProp=plane(0.34,0.26,MATS.paper,x-0.6,1.0,z-1.15,0.12,-0.3);
  const mapInt=addInteract({x:x-0.6,z:z-1.15,y:1.0,r:1.7,type:"map",prompt:STR.pTakeMap,
    use(){
      if(Game.hasMap) return;
      Game.hasMap=true;
      mapProp.visible=false; mapInt.active=false;
      Game.tasks.map=true; Events.fire("mapChecked");
      UI.showMinimap();
      UI.toast(STR.toastMapTaken);
    }});
  plane(1.5,1.1,new THREE.MeshLambertMaterial({map:TEX.wallMap()}),x-W/2+0.1,1.7,z+0.6,Math.PI/2);
  addInteract({x:x-W/2+0.5,z:z+0.6,y:1.7,r:2.0,type:"read",prompt:STR.pRead,text:STR.noteWallMap,
    use(){}});
  plane(1.1,0.8,new THREE.MeshLambertMaterial({map:TEX.sign("TRAIL ADVISORIES\n\n[      ]   [      ]\n\n[  6  — missing  ]",{w:220,h:160,size:12,top:30,lh:24})}),
    x+1.4,1.7,z-D/2+0.09,0);
  addInteract({x:x+1.4,z:z-D/2+0.5,y:1.7,r:1.8,type:"read",prompt:STR.pRead,text:STR.noteMissing,use(){}});
  box(1.9,0.12,0.9,MATS.woodDark,x+1.6,0.42,z+1.5,0,true);
  box(0.08,0.7,0.9,MATS.woodDark,x+2.5,0.55,z+1.5);
  for(let i=0;i<5;i++)box(0.25,0.04,0.9,MATS.wood,x+0.85+i*0.36,0.49,z+1.5);
  Triggers.push({x:x+W/2+2.6,z,r:2.6,cond:()=>Game.tasks.map&&Game.tasks.radio&&Game.phase==="outpost",
    fn(){ Phases.toErase(); }});
  return {x,z};
}
function buildBridge(){
  const z=-120, x=pathX(z);
  for(let i=0;i<8;i++) box(2.6,0.07,0.55,MATS.planks,x,0.18,z-2.2+i*0.62);
  box(0.1,0.85,5.2,MATS.woodDark,x-1.25,0.6,z,0,false);
  box(0.1,0.85,5.2,MATS.woodDark,x+1.25,0.6,z,0,false);
  box(0.08,0.06,5.2,MATS.wood,x-1.25,1.02,z); box(0.08,0.06,5.2,MATS.wood,x+1.25,1.02,z);
  addBoxCol(x-1.3,z,0.3,5.4); addBoxCol(x+1.3,z,0.3,5.4);
  // creek banks funnel the player onto the bridge
  addBoxCol(x-9,z,15,3.8); addBoxCol(x+9.5,z,16,3.8);
  return {x,z};
}
function buildCabin(){ // distant boarded cabin — set dressing
  const z=-141, x=pathX(z)+21;
  const useGLB = placeBuilding("cabin",x,z,0.4,4.2);
  if(!useGLB){
    box(3.4,2.3,2.8,MATS.planksDark,x,1.35,z,0.4,true);
    const r=box(4.0,0.1,1.9,MATS.metal,x-0.6,2.7,z,0.4); r.rotation.x=0.45;
    const r2=box(4.0,0.1,1.9,MATS.metal,x+0.6,2.75,z,0.4); r2.rotation.x=-0.45;
    box(0.9,1.6,0.08,MATS.wood,x-0.4,1.0,z+1.45,0.4);     // boarded door
    box(1.1,0.16,0.1,MATS.woodDark,x-0.4,1.2,z+1.5,0.75);
    box(1.1,0.16,0.1,MATS.woodDark,x-0.4,0.8,z+1.5,0.1);
  } else {
    box(3.4,2.3,2.8,MATS.planksDark,x,1.35,z,0.4,true,true); // invisible collider
  }
}

// ============================================================================
// THE ABANDONED CLEARING — revealed after all markers are collected. A cluster of
// long-abandoned cabins past the end of the trail. Inspecting each reveals how
// long they've been empty; the last one triggers the concerned radio + lost path.
// ============================================================================
let clearingGroup=null;
const clearingCabins=[];
function buildAbandonedClearing(){
  clearingGroup=new THREE.Group(); clearingGroup.visible=false; scene.add(clearingGroup);
  // clearing centered past the trail end
  const cz=-228, cx=pathX(-198);
  // prefer bespoke abandoned cabins; fall back to existing cabin/outpost/shed meshes
  const pick=(i)=>{
    const bespoke=["cabin_abandoned_1","cabin_abandoned_2","cabin_abandoned_3","cabin_abandoned_4"][i];
    if(BUILDING_GLB[bespoke]) return bespoke;
    return ["cabin","outpost","shed","cabin"][i];
  };
  const spots=[
    {x:cx-12,z:cz+6, ry:0.6},
    {x:cx+11,z:cz+2, ry:-0.7},
    {x:cx-7, z:cz-12,ry:2.4},
    {x:cx+9, z:cz-14,ry:-2.1},
  ];
  spots.forEach((s,i)=>{
    const name=pick(i);
    const b=BUILDING_GLB[name];
    if(b){
      const g=b.root.clone(true);
      const k=4.6/(b.dims.w||1); g.scale.setScalar(k);
      g.rotation.y=s.ry; g.updateWorldMatrix(true,true);
      const bb=new THREE.Box3().setFromObject(g);
      g.position.set(s.x,-bb.min.y,s.z);
      clearingGroup.add(g);
    } else {
      // procedural derelict fallback
      const m=new THREE.Mesh(new THREE.BoxGeometry(3.6,2.4,3.0),MATS.planksDark);
      m.position.set(s.x,1.2,s.z); m.rotation.y=s.ry; clearingGroup.add(m);
    }
    addBoxCol(s.x,s.z,4.2,4.2,s.ry);
    // inspect interactable in front of each cabin door
    const ix=s.x+Math.sin(s.ry+Math.PI)*2.6, iz=s.z+Math.cos(s.ry+Math.PI)*2.6;
    const it=addInteract({x:ix,z:iz,y:1.2,r:2.6,type:"inspect",prompt:STR.pInspect,active:false,
      text:STR["cabinNote"+(i+1)],
      use(){
        if(it.done) return; it.done=true;
        it.active=false;
        Game.tasks.inspected=(Game.tasks.inspected||0)+1;
        AudioSys.creak(ix,iz);
        UI.refresh();
        Events.fire("cabinInspected");
      }});
    clearingCabins.push(it);
  });
  // a few dead trees + a cold fire ring to dress the clearing
  for(let i=0;i<5;i++){
    const a=rng()*6.28, rr=R(14,22);
    box(0.3,R(3,5),0.3,MATS.woodDark, cx+Math.cos(a)*rr, 2, cz+Math.sin(a)*rr, rng());
  }
}
function revealClearing(){
  if(clearingGroup) clearingGroup.visible=true;
  for(const it of clearingCabins) it.active=true;
}

// ============================================================================
// SHADOW WALKERS — black humanoid silhouettes that walk between the trees behind
// the player while inspecting the cabins. Never approach; just drift across,
// half-seen between trunks.
// ============================================================================
const ShadowWalkers={
  list:[], active:false,
  build(){
    for(let i=0;i<5;i++){
      const g=new THREE.Group();
      const torso=new THREE.Mesh(new THREE.CapsuleGeometry?new THREE.CylinderGeometry(0.16,0.2,1.0,7):new THREE.CylinderGeometry(0.16,0.2,1.0,7),MATS.dark);
      torso.position.y=1.05; g.add(torso);
      const head=new THREE.Mesh(new THREE.SphereGeometry(0.16,8,6),MATS.dark); head.position.y=1.7; g.add(head);
      const la=new THREE.Mesh(new THREE.CylinderGeometry(0.07,0.07,0.8,5),MATS.dark); la.position.set(-0.14,0.45,0); g.add(la);
      const ra=la.clone(); ra.position.x=0.14; g.add(ra);
      g.visible=false; g.userData={phase:rng()*6.28,speed:R(0.5,0.9),baseX:0,baseZ:0,dir:1};
      scene.add(g); this.list.push(g);
    }
  },
  start(){
    if(this.active) return; this.active=true;
    const p=Game.player;
    this.list.forEach((g,i)=>{
      // place them in a ring behind/around the clearing, among the trees
      const a=Math.PI*0.5 + (i/this.list.length)*Math.PI*1.0 + R(-0.3,0.3);
      const r=R(16,26);
      g.userData.baseX=p.x+Math.cos(a)*r;
      g.userData.baseZ=p.z+Math.sin(a)*r;
      g.userData.dir=rng()<0.5?1:-1;
      g.position.set(g.userData.baseX,0,g.userData.baseZ);
      g.visible=true;
    });
    AudioSys.creak(p.x+10,p.z+10);
  },
  stop(){ this.active=false; for(const g of this.list) g.visible=false; },
  tick(dt){
    if(!this.active) return;
    const t=performance.now()*0.001;
    for(const g of this.list){
      const u=g.userData;
      // drift sideways between trees, bobbing slightly; face travel direction
      u.baseX += Math.cos(u.phase)*u.speed*u.dir*dt*1.4;
      u.baseZ += Math.sin(u.phase)*u.speed*u.dir*dt*1.4;
      g.position.x=u.baseX; g.position.z=u.baseZ;
      g.position.y=Math.sin(t*4+u.phase)*0.03;
      g.rotation.y=Math.atan2(Math.cos(u.phase)*u.dir,Math.sin(u.phase)*u.dir);
      // keep them at a distance — if they wander too close, push them out
      const d=Math.hypot(g.position.x-Game.player.x,g.position.z-Game.player.z);
      if(d<11){ u.dir*=-1; }
    }
  }
};

// Close the original path: fill the trail behind the player with trees so they
// can't retrace their steps back to the car.
let pathClosed=false;
function closeThePath(){
  if(pathClosed||!TREE_GLBS.length) return; pathClosed=true;
  const M=new THREE.Matrix4(),Q=new THREE.Quaternion(),S=new THREE.Vector3(),P=new THREE.Vector3();
  const buckets=TREE_GLBS.map(()=>[]);
  // pack trees densely right across and along the whole trail corridor
  for(let z=12; z>=-204; z-=2.0){
    const px=pathX(z);
    for(let off=-6; off<=6; off+=2.2){
      buckets[Math.floor(rng()*TREE_GLBS.length)].push({x:px+off+R(-0.8,0.8), z:z+R(-0.8,0.8), s:R(0.9,1.5), rot:rng()*6.28});
    }
  }
  const TARGET_H=7.0;
  TREE_GLBS.forEach((glb,vi)=>{
    const mine=buckets[vi]; if(!mine.length) return;
    const k=TARGET_H/(glb.unitH||1);
    const inst=new THREE.InstancedMesh(glb.geometry,glb.material,mine.length);
    mine.forEach((tr,i)=>{ P.set(tr.x,0,tr.z);Q.setFromEuler(new THREE.Euler(0,tr.rot,0));const sc=k*tr.s;S.set(sc,sc,sc);M.compose(P,Q,S);inst.setMatrixAt(i,M);
      addCircle(tr.x,tr.z,0.6); });
    inst.instanceMatrix.needsUpdate=true; scene.add(inst);
  });
  // also lift the soft z-bound so the player is now penned in the clearing
  Game.penned=true;
}
function buildTrailhead(){
  const x=1.6,z=8.5;
  // two posts
  box(0.12,1.6,0.12,MATS.woodDark,x-0.78,0.8,z,0,true);
  box(0.12,1.6,0.12,MATS.woodDark,x+0.78,0.8,z,0,true);
  // a solid backing board across the posts, and the readable text mounted just in
  // FRONT of it (toward the player at -z) so it never clips behind the posts.
  box(1.78,0.98,0.08,MATS.planksDark,x,1.35,z+0.02,0,true);   // backing board
  trailheadSign=plane(1.6,0.86,new THREE.MeshLambertMaterial({map:TEX.sign(STR.signTrailhead,{w:300,h:170,size:13,top:40,lh:26})}),x,1.35,z-0.045,0);
  // a small angled top cap so it reads as a real trailhead board
  const cap=box(1.9,0.1,0.34,MATS.metal,x,1.9,z); cap.rotation.x=-0.22;
  addInteract({x,z,y:1.3,r:2.4,type:"read",prompt:STR.pRead,
    get text(){ return Game.signChanged?STR.signTrailheadChanged:STR.signTrailhead; },use(){}});
  // high-fidelity carved signpost mesh standing beside the board as the hero marker
  const sp=BUILDING_GLB.signpost;
  if(sp){
    const g=sp.root.clone(true);
    const k=2.6/(sp.dims.h||1);
    g.scale.setScalar(k);
    g.rotation.y=-0.35;
    g.updateWorldMatrix(true,true);
    const bb=new THREE.Box3().setFromObject(g);
    g.position.set(x-2.6, -bb.min.y, z+0.4);
    scene.add(g);
    addBoxCol(x-2.6,z+0.4,0.7,0.7,0);
  }
  // fire ring + log
  const ring=new THREE.Mesh(new THREE.TorusGeometry(0.5,0.12,5,8),MATS.rock);
  ring.rotation.x=Math.PI/2; ring.position.set(-3,0.1,7); scene.add(ring);
  box(1.6,0.3,0.3,MATS.woodDark,-3.2,0.16,5.4,0.4,true);
  // scenic loop sign for the bad ending — hidden until dawn
  scenicSign=new THREE.Group();
  const p=new THREE.Mesh(new THREE.BoxGeometry(0.1,1.4,0.1),MATS.woodDark);p.position.y=0.7;scenicSign.add(p);
  const s=new THREE.Mesh(new THREE.PlaneGeometry(1.3,0.5),
    new THREE.MeshBasicMaterial({map:TEX.sign(STR.signScenic,{w:300,h:110,size:18,top:62,bg:"#9c2a20",fg:"#efe6d2"})}));
  s.position.set(0,1.25,0.06); s.rotation.y=Math.PI; scenicSign.add(s);
  scenicSign.position.set(-1.8,0,7.5); scenicSign.visible=false; scene.add(scenicSign);
  // trailhead return trigger (good ending path)
  Triggers.push({x:0,z:7,r:3.4,cond:()=>Game.phase==="return",fn(){ Endings.good(); }});
}

// An empty gravel parking lot at the start. The player spawns here in the open,
// with the trailhead sign marking where the lot meets the trees.
function buildParkingLot(){
  const cz=14;                 // lot center z
  // gravel pad
  const lot=new THREE.Mesh(new THREE.PlaneGeometry(30,18),MATS.gravel);
  lot.rotation.x=-Math.PI/2; lot.position.set(1.6,0.0,cz); scene.add(lot);
  // wheel stops (low concrete blocks) in a row at the back of the lot
  for(let i=-2;i<=2;i++){
    box(1.4,0.18,0.3,MATS.rock,1.6+i*3.2,0.09,20.5,0,false);
  }
  // a low log barrier on the lot's outer edges (rustic trailhead boundary)
  box(0.3,0.4,16,MATS.woodDark,-13.5,0.2,cz,0,true);   // west edge
  box(0.3,0.4,16,MATS.woodDark,16.5,0.2,cz,0,true);    // east edge
  // a battered trail-information board off to the side of the lot entrance —
  // text mounted in FRONT of a solid backing board so it doesn't clip the poles
  box(0.1,1.7,0.1,MATS.woodDark,-7.05,0.85,11.55,0,true);
  box(0.1,1.7,0.1,MATS.woodDark,-4.95,0.85,11.55,0,true);
  const bbk=box(2.18,1.12,0.08,MATS.planksDark,-6.0,1.45,11.5,-0.3,true);  // backing
  const board=plane(2.0,1.0,new THREE.MeshLambertMaterial({map:TEX.sign(STR.signParking,{w:300,h:150,size:15,top:38,lh:28,bg:"#5b6354",fg:"#e8e2cf"})}),-6.0,1.45,11.42,-0.3);
  addInteract({x:-6.0,z:11.5,y:1.4,r:2.4,type:"read",prompt:STR.pRead,text:STR.noteParking,use(){}});
}

// Pack extra trees and bushes into the four corners of the backdrop box and along
// the box edges behind the start, so the player never sees a flat wall or seam.
function padBackdropCorners(){
  if(!TREE_GLBS.length) return;
  const M=new THREE.Matrix4(),Q=new THREE.Quaternion(),S=new THREE.Vector3(),P=new THREE.Vector3();
  const TARGET_H=7.0;
  const tBuckets=TREE_GLBS.map(()=>[]);
  const bBuckets=BUSH_GLBS.map(()=>[]);
  // corner anchor points just inside the box walls (box is x∈[-58,58], z∈[-214,32])
  const corners=[[-50,22],[50,22],[-50,-206],[50,-206]];
  // plus a dense screen straight behind the start (player stops at z=21, wall at 32)
  const screens=[];
  for(let x=-46;x<=46;x+=5) screens.push([x,27]);
  const spots=corners.concat(screens);
  for(const [ax,az] of spots){
    const clusterN = az>18 ? 16 : 10;     // denser behind the start
    for(let i=0;i<clusterN;i++){
      const x=ax+R(-9,9);
      let z=az+R(-6,6);
      if(az>18) z=Math.max(z,23.5);    // never spill into the walkable lot
      const s=R(1.0,1.6), rot=rng()*6.28;
      const vi=Math.floor(rng()*TREE_GLBS.length);
      tBuckets[vi].push({x,z,s,rot});
      if(BUSH_GLBS.length && rng()<0.7){
        const bx=x+R(-3,3), bz=z+R(-3,3);
        bBuckets[Math.floor(rng()*BUSH_GLBS.length)].push({x:bx,z:bz,s:R(0.8,1.5),rot:rng()*6.28});
      }
    }
  }
  TREE_GLBS.forEach((glb,vi)=>{
    const mine=tBuckets[vi]; if(!mine.length) return;
    const k=TARGET_H/(glb.unitH||1);
    const inst=new THREE.InstancedMesh(glb.geometry,glb.material,mine.length);
    mine.forEach((t,i)=>{ P.set(t.x,0,t.z);Q.setFromEuler(new THREE.Euler(0,t.rot,0));const sc=k*t.s;S.set(sc,sc,sc);M.compose(P,Q,S);inst.setMatrixAt(i,M); });
    inst.instanceMatrix.needsUpdate=true; scene.add(inst);
  });
  BUSH_GLBS.forEach((glb,vi)=>{
    const mine=bBuckets[vi]; if(!mine.length) return;
    const k=0.85/(glb.unitH||1);
    const inst=new THREE.InstancedMesh(glb.geometry,glb.material,mine.length);
    mine.forEach((b,i)=>{ P.set(b.x,0,b.z);Q.setFromEuler(new THREE.Euler(0,b.rot,0));const sc=k*b.s;S.set(sc,sc,sc);M.compose(P,Q,S);inst.setMatrixAt(i,M); });
    inst.instanceMatrix.needsUpdate=true; scene.add(inst);
  });
}
function buildFigure(){
  figure=new THREE.Group();
  const b=new THREE.Mesh(new THREE.BoxGeometry(0.5,1.25,0.3),MATS.dark);b.position.y=0.95;figure.add(b);
  const h=new THREE.Mesh(new THREE.BoxGeometry(0.26,0.3,0.26),MATS.dark);h.position.y=1.75;figure.add(h);
  const l1=new THREE.Mesh(new THREE.BoxGeometry(0.16,0.7,0.16),MATS.dark);l1.position.set(-0.13,0.35,0);figure.add(l1);
  const l2=l1.clone();l2.position.x=0.13;figure.add(l2);
  figure.visible=false; scene.add(figure);
}

/* ---------- task objects: branches, white markers, red markers ---------- */
function buildBranches(){
  const Z=[-13,-36,-58];
  Z.forEach((z,idx)=>{
    const x=pathX(z);
    // direction the log should roll: toward the side of the path away from center
    const rollDir = (idx%2===0) ? 1 : -1;
    let grp;
    let rad=0.4, len=3.6;
    if(LOG_GLB){
      grp=new THREE.Group();
      const m=new THREE.Mesh(LOG_GLB.geometry,LOG_GLB.material);
      // scale so the log spans ~4m across the path (bigger than before)
      len=4.2;
      const k=len/(LOG_GLB.longest||1);
      m.scale.setScalar(k);
      // orient the log's long axis across the path (along world X)
      // figure out which local axis is longest and rotate it to X
      const d=LOG_GLB.dims;
      if(d.z>=d.x && d.z>=d.y) m.rotation.y=Math.PI/2;      // long axis Z -> X
      else if(d.y>=d.x && d.y>=d.z) m.rotation.z=Math.PI/2; // long axis Y -> X
      rad = 0.5*k*Math.min(d.x,d.y,d.z);                    // rolling radius ≈ half the short dim
      if(rad<0.25) rad=0.45;
      grp.add(m);
      grp.position.set(x,rad,z);
      grp.rotation.y=R(-0.15,0.15);
      scene.add(grp);
    } else {
      // procedural fallback log — thicker and bigger, centered on its axis so it
      // rolls cleanly. Built from a main trunk + a couple of stub branches + an
      // end cap to read as a storm-snapped log.
      grp=new THREE.Group();
      rad=0.34;
      const main=new THREE.Mesh(new THREE.CylinderGeometry(rad,rad*0.92,4.2,9),MATS.woodDark);
      main.rotation.z=Math.PI/2; grp.add(main);
      // splintered lighter end caps
      const cap=new THREE.Mesh(new THREE.ConeGeometry(rad*0.9,0.5,9),MATS.wood);
      cap.rotation.z=-Math.PI/2; cap.position.x=2.1; grp.add(cap);
      // a few stub branches
      for(let i=0;i<3;i++){
        const tw=new THREE.Mesh(new THREE.CylinderGeometry(0.05,0.08,R(0.5,0.9),5),MATS.woodDark);
        tw.position.set(R(-1.6,1.6),R(-0.1,0.2),R(-0.15,0.15));
        tw.rotation.set(R(-0.6,0.6),R(0,3),Math.PI/2+R(-0.6,0.6)); grp.add(tw);
      }
      grp.position.set(x,rad,z);
      grp.rotation.y=R(-0.12,0.12);
      scene.add(grp);
    }
    const col={x,z,r:1.2}; addCircle(x,z,1.2);
    const it=addInteract({x,z,y:0.5,r:2.4,type:"branch",prompt:STR.pBranch,node:grp,
      use(){
        it.active=false; AudioSys.rustle(x,z);
        const i=colCircles.indexOf(col); if(i>=0)colCircles.splice(i,1);
        // realistic slow roll: rotate about the path-axis (Z) while translating in X.
        // distance rolled D over a turn of D/rad radians, eased over a long beat.
        const D=3.4*rollDir;                  // how far it rolls off the path
        const baseRotZ=grp.rotation.z, baseX=grp.position.x;
        const turns=D/rad;                    // radians to roll that distance
        Anim.push({t:0,dur:2.6,fn(k){
          // easeInOutSine for a heavy, settling feel
          const e=0.5-0.5*Math.cos(Math.PI*k);
          grp.position.x=baseX+D*e;
          grp.rotation.z=baseRotZ-turns*e;
          // purely horizontal roll — height stays constant
          grp.position.y=rad;
        }, end(){ grp.position.y=rad; }});
        Game.tasks.branches++; Events.fire("branchCleared"); UI.refresh();
      }});
    branches.push(it);
  });
}
function buildWhiteMarkers(trees){
  const Z=[-22,-44,-66];
  for(const z of Z){
    const t=nearestTree(trees,pathX(z),z,2.5,8);
    if(!t) continue;
    const m=markerOnTree(t,z+4,MATS.markerFaded);
    const it=addInteract({x:m.position.x,z:m.position.z,y:1.55,r:2.3,type:"paint",prompt:STR.pPaint,node:m,
      use(){
        it.active=false;
        AudioSys.play("brush",0.7)||0;
        Anim.push({t:0,dur:0.9,fn(k){m.material.color.lerpColors(new THREE.Color(0x8d8d7c),new THREE.Color(0xeeeede),k);}});
        Game.tasks.markers++; Events.fire("markerPainted"); UI.refresh();
      }});
    whiteMarkers.push(it);
  }
}
function buildRedMarkers(trees){
  // The markers are knocked loose and lie ON THE GROUND along the trail. You can't
  // tell where they're meant to go, so you just collect them. Placed at intervals
  // down the path so collecting them walks you deeper toward the clearing.
  const zs=[-150,-128,-104,-78,-50,-24];
  for(const z of zs){
    const px=pathX(z);
    const x=px+R(-1.6,1.6);            // scattered near the trail surface
    const m=makeMarkerPlane(MATS.markerRed);
    m.position.set(x,0.06,z); m.rotation.x=-Math.PI/2; m.rotation.z=rng()*6.28;
    m.visible=false; scene.add(m);
    const it=addInteract({x,z,y:0.3,r:2.2,type:"collect",prompt:STR.pCollect,node:m,active:false,erased:false,
      use(){
        it.active=false; it.erased=true;
        AudioSys.play("brush",0.6,{rate:1.1});
        Anim.push({t:0,dur:0.4,fn(k){m.position.y=0.06+k*0.6;m.material.opacity=1-k;m.material.transparent=true;},
          end(){m.visible=false;}});
        Game.tasks.erased=redMarkers.filter(r=>r.erased).length;
        UI.refresh();
        setTimeout(()=>{Game.tasks.erased=redMarkers.filter(r=>r.erased).length;UI.refresh();
          Events.fire("collected");},420);
      }});
    redMarkers.push(it);
  }
}
function revealRedMarkers(){
  for(const r of redMarkers){ r.node.visible=true; r.node.material.opacity=1; r.active=true; r.erased=false; }
  Game.tasks.erased=0;
}
// the unseen restorer is gone — markers are collected, not restored


/* ============================ events / triggers / phases ============================ */
const Triggers=[]; // {x,z,r,once?,cond?,fn,fired?}
const Anim=[];     // {t,dur,fn(k),end?}
const Events={
  fired:new Set(),
  fire(name){
    switch(name){
      case "branchCleared":
        if(Game.tasks.branches===2 && !this.fired.has("snap")){ this.fired.add("snap");
          setTimeout(()=>{const p=Game.player;
            AudioSys.snap(p.x-Math.sin(p.yaw)*7,p.z-Math.cos(p.yaw)*7);},1800); }
        if(Game.tasks.branches>=Game.tasks.branchesTotal) UI.toast(STR.toastBranchesDone);
        Phases.checkIntroDone(); break;
      case "markerPainted":
        if(Game.tasks.markers===Game.tasks.markersTotal && !this.fired.has("hammer1")){
          this.fired.add("hammer1"); UI.toast(STR.toastMarkersDone);
          setTimeout(()=>AudioSys.play3D("hammer",Game.player.x+30,Game.player.z-40,{vol:0.8,range:90}),2500);
        }
        Phases.checkIntroDone(); break;
      case "shedSign":
        if(Game.phase==="shed") Phases.toOutpost(); break;
      case "radioChecked":
        AudioSys.dispatch("continue"); UI.glitch(); UI.refresh(); break;
      case "mapChecked": UI.refresh(); break;
      case "collected":
        if(Game.phase==="erase"){
          // a shadow flickers between the trees as you gather them
          if(!this.fired.has("fig2") && Game.tasks.erased>=2){ this.fired.add("fig2");
            Glimpse.show(pathX(-80)-6,-80,4500); }
          if(Game.tasks.erased>=Game.tasks.eraseTotal) Phases.toClearing();
        }
        break;
      case "cabinInspected":
        if(!this.fired.has("shadows")){ this.fired.add("shadows");
          setTimeout(()=>{ ShadowWalkers.start(); AudioSys.rustle(Game.player.x+8,Game.player.z+8); }, 900); }
        UI.glitch();
        if((Game.tasks.inspected||0) >= clearingCabins.length){ Phases.toLost(); }
        break;
    }
  }
};
const Glimpse={
  until:0,
  show(x,z,ms){
    figure.position.set(x,0,z);
    figure.lookAt(Game.player.x,0,Game.player.z);
    figure.visible=true; this.until=performance.now()+ms;
    AudioSys.creak(x,z);
  },
  tick(){
    if(!figure||!figure.visible) return;
    const d=Math.hypot(figure.position.x-Game.player.x,figure.position.z-Game.player.z);
    if(performance.now()>this.until || d<10) figure.visible=false;
  }
};
const Phases={
  checkIntroDone(){
    if(Game.phase==="intro" && Game.tasks.branches>=3 && Game.tasks.markers>=3){
      Game.phase="shed"; UI.refresh();
    }
  },
  toOutpost(){ Game.phase="outpost"; UI.refresh();
    // walking between shed and outpost: the shed light behind you + a figure ahead
    Triggers.push({x:pathX(-112),z:-112,r:5,once:true,fn(){
      shedGlow.visible=true; shedLight.intensity=1.4; AudioSys.creak(pathX(-92)+6,-92);
      setTimeout(()=>UI.toast(""),10);
    }});
    Triggers.push({x:pathX(-138),z:-138,r:5,once:true,fn(){
      Glimpse.show(pathX(-152)+4,-152,3500);
    }});
    // approaching the lit shed again puts the light out
    Triggers.push({x:pathX(-92)+4,z:-92,r:8,cond:()=>shedGlow.visible,fn(){
      shedGlow.visible=false; shedLight.intensity=0;
    }});
  },
  toErase(){
    Game.phase="erase"; revealRedMarkers();
    AudioSys.dispatch("confirmed",0.6);
    UI.toast(STR.toastRedFound); UI.glitch(); UI.refresh();
  },
  toClearing(){
    Game.phase="clearing"; UI.refresh();
    AudioSys.creak(pathX(-200),-205);
    UI.toast(STR.toastClearing);
    revealClearing();   // shows the abandoned cabins ahead
  },
  // after inspecting the last cabin: the concerned radio, then the path is gone
  toLost(){
    Game.phase="lost"; UI.refresh();
    setTimeout(()=>{ AudioSys.dispatchConcerned(); }, 1200);
    setTimeout(()=>{ UI.toast(STR.toastLost); closeThePath();
      // once penned in, trying to leave the clearing the way you came ends it
      Triggers.push({x:pathX(-198),z:-200,r:8,once:true,fn(){ setTimeout(()=>Endings.lost(),1500); }});
    }, 5200);
  },
  toReturn(){
    Game.phase="return"; Game.dawnT=-1;
    AudioSys.setWind(0.04,6); AudioSys.setCrickets(0.0,4);
    UI.toast(STR.toastSilence);
    trailheadSign.visible=false;
    UI.refresh();
  }
};
const Endings={
  done:false,
  good(){
    if(this.done)return; this.done=true; Game.state="ended";
    AudioSys.setWind(0,3);
    UI.fadeOut(()=>UI.ending(STR.endGoodTitle,STR.endGoodText));
  },
  bad(){
    if(this.done)return; this.done=true; Game.state="ended";
    // morning arrives
    scenicSign.visible=true;
    Anim.push({t:0,dur:1,fn(k){
      scene.fog.color.setRGB(lerp(0.078,0.55,k),lerp(0.10,0.58,k),lerp(0.11,0.56,k));
      scene.background.copy(scene.fog.color);
      if(skyDome){ skyDome.material.uniforms.top.value.setRGB(lerp(0.02,0.42,k),lerp(0.03,0.48,k),lerp(0.04,0.52,k));
        skyDome.material.uniforms.bottom.value.copy(scene.fog.color); }
      hemi.intensity=lerp(0.55,1.1,k); }});
    AudioSys.murmur();
    setTimeout(()=>UI.fadeOut(()=>UI.ending(STR.endBadTitle,STR.endBadText)),4500);
  },
  lost(){
    if(this.done)return; this.done=true; Game.state="ended";
    AudioSys.setWind(0.5,3); ShadowWalkers.stop();
    AudioSys.staticBurst(0.5,2.0);
    UI.fadeOut(()=>UI.ending(STR.endLostTitle,STR.endLostText));
  }
};

/* ============================ UI ============================ */
const UI={
  refresh(){
    const t=Game.tasks; let obj="",rows=[];
    const tk=(label,done)=>`<div class="tk ${done?"done":""}">- ${label}${typeof done==="number"?"":""}</div>`;
    if(Game.phase==="intro"){
      obj=STR.objClear;
      rows.push(tk(`${STR.taskBranches} (${t.branches}/${t.branchesTotal})`,t.branches>=t.branchesTotal));
      rows.push(tk(`${STR.taskMarkers} (${t.markers}/${t.markersTotal})`,t.markers>=t.markersTotal));
    } else if(Game.phase==="shed"){
      obj=STR.objShed; rows.push(tk(STR.taskShedSign,t.shedSign));
    } else if(Game.phase==="outpost"){
      obj=STR.objOutpost;
      rows.push(tk(STR.taskMap,t.map)); rows.push(tk(STR.taskRadio,t.radio));
    } else if(Game.phase==="erase"){
      obj=STR.objCollect;
      rows.push(tk(`${STR.taskCollect} (${t.erased}/${t.eraseTotal})`,t.erased>=t.eraseTotal));
    } else if(Game.phase==="clearing"){
      obj=STR.objClearing;
      rows.push(tk(`${STR.taskInspect} (${t.inspected||0}/${clearingCabins.length})`,(t.inspected||0)>=clearingCabins.length));
    } else if(Game.phase==="lost"){
      obj=STR.objLost;
    } else if(Game.phase==="return"){
      obj=STR.objReturn;
    }
    $("checklist").innerHTML=`<div class="obj">${obj}</div>`+rows.join("");
    $("counter").textContent = "";
    $("dawn").style.opacity = 0;
  },
  prompt(txt){ const p=$("prompt"); p.textContent=txt||""; p.style.opacity=txt?1:0; },
  toast(txt){ if(!txt)return; const e=$("toast"); e.textContent=txt; e.style.opacity=1;
    clearTimeout(this._tt); this._tt=setTimeout(()=>e.style.opacity=0,3500); },
  showMinimap(){ $("minimap").style.display="block"; this._mmReady=true; },
  drawMinimap(){
    if(!this._mmReady) return;
    const cv=$("minimapcv"); if(!cv) return;
    const ctx=cv.getContext("2d"), W=cv.width, H=cv.height;
    // compute path bounds once
    if(!this._mmB){
      let minx=1e9,maxx=-1e9,minz=1e9,maxz=-1e9;
      for(const p of pathSamples){ minx=Math.min(minx,p.x);maxx=Math.max(maxx,p.x);minz=Math.min(minz,p.z);maxz=Math.max(maxz,p.z); }
      const padX=10, padZ=8;
      this._mmB={minx:minx-padX,maxx:maxx+padX,minz:minz-padZ,maxz:maxz+padZ};
    }
    const b=this._mmB, pad=14;
    const sx=v=>pad+((v-b.minx)/(b.maxx-b.minx))*(W-2*pad);
    // z grows negative down-trail; map far end (-198) to bottom, start (+20) to top
    const sz=v=>pad+((b.maxz-v)/(b.maxz-b.minz))*(H-2*pad);
    ctx.clearRect(0,0,W,H);
    // aged paper background
    ctx.fillStyle="#d8cba6"; ctx.fillRect(0,0,W,H);
    ctx.fillStyle="rgba(120,100,60,0.10)";
    for(let i=0;i<40;i++){ const rx=Math.random()*W,ry=Math.random()*H; ctx.fillRect(rx,ry,2,2); }
    // trail line
    ctx.strokeStyle="#5a4a2c"; ctx.lineWidth=2.4; ctx.lineJoin="round"; ctx.beginPath();
    pathSamples.forEach((p,i)=>{ const X=sx(p.x),Y=sz(p.z); i?ctx.lineTo(X,Y):ctx.moveTo(X,Y); });
    ctx.stroke();
    // dashed casing
    ctx.strokeStyle="rgba(90,74,44,0.4)"; ctx.lineWidth=5; ctx.stroke();
    // landmarks
    const mark=(wx,wz,label,col)=>{ const X=sx(wx),Y=sz(wz);
      ctx.fillStyle=col; ctx.fillRect(X-2.5,Y-2.5,5,5);
      ctx.fillStyle="#3a2e1a"; ctx.font="8px 'Courier New',monospace"; ctx.fillText(label,X+5,Y+3); };
    mark(1.6,14,"LOT","#6b5a36");
    mark(pathX(-92)+6.8,-92,"SHED","#6b5a36");
    mark(pathX(-168)-7.5,-168,"OUTPOST","#6b5a36");
    mark(0,-120,"BRIDGE","#6b5a36");
    // player position + facing
    const p=Game.player, PX=sx(p.x), PY=sz(p.z);
    ctx.save(); ctx.translate(PX,PY); ctx.rotate(-p.yaw);
    ctx.fillStyle="#b23030"; ctx.beginPath();
    ctx.moveTo(0,-6); ctx.lineTo(4,5); ctx.lineTo(0,2); ctx.lineTo(-4,5); ctx.closePath(); ctx.fill();
    ctx.restore();
  },
  radioLine(txt){ const e=$("radioline"); e.textContent=txt; e.style.opacity=0.95;
    clearTimeout(this._rt); this._rt=setTimeout(()=>e.style.opacity=0,3000); },
  read(text){
    Game.state="reading";
    if(Input.locked) document.exitPointerLock();
    $("readpaper").textContent=text;
    $("readclose").textContent=STR.close;
    $("read").style.display="block";
  },
  closeRead(){ $("read").style.display="none"; if(Game.state==="reading") Game.state="play"; },
  glitch(){
    const tr=$("tracking");
    tr.style.top=(Math.random()*70+10)+"%"; tr.style.opacity=0.8;
    let y=parseFloat(tr.style.top);
    const iv=setInterval(()=>{ y+=4; tr.style.top=y+"%"; if(y>110){clearInterval(iv);tr.style.opacity=0;} },30);
  },
  fadeOut(cb){ const f=$("fade"); f.style.transition="opacity 2.5s"; f.style.opacity=1; setTimeout(cb,2700); },
  fadeIn(){ const f=$("fade"); f.style.opacity=0; },
  ending(title,text){
    $("ending").style.display="block";
    $("endtitle").textContent=""; $("endtext").textContent="";
    $("endbtn").textContent=STR.endRestart;
    // slow typed reveal
    let i=0; const t1=setInterval(()=>{ $("endtitle").textContent=title.slice(0,++i);
      if(i>=title.length){clearInterval(t1);
        let j=0; const t2=setInterval(()=>{ $("endtext").textContent=text.slice(0,++j);
          if(j>=text.length)clearInterval(t2); },55); } },120);
  },
  clock(){
    const h24=Math.floor(Game.timecode/3600)%24, m=Math.floor(Game.timecode/60)%60;
    const ap=h24>=12?"PM":"AM"; const h=((h24+11)%12)+1;
    $("timecode").textContent=`${ap} ${h}:${String(m).padStart(2,"0")}`;
  }
};
$("endbtn")?.addEventListener("click",()=>location.reload());
$("read").addEventListener("click",()=>UI.closeRead());

/* ============================ movement / interaction ============================ */
function resolveCollisions(){
  const p=Game.player, r=0.36;
  for(const c of colCircles){
    const dx=p.x-c.x,dz=p.z-c.z,d=Math.hypot(dx,dz),min=c.r+r;
    if(d<min&&d>0.0001){p.x=c.x+dx/d*min;p.z=c.z+dz/d*min;}
  }
  for(const b of colBoxes){
    if(p.x>b.minx-r&&p.x<b.maxx+r&&p.z>b.minz-r&&p.z<b.maxz+r){
      const dl=p.x-(b.minx-r),dr=(b.maxx+r)-p.x,dn=p.z-(b.minz-r),df=(b.maxz+r)-p.z;
      const m=Math.min(dl,dr,dn,df);
      if(m===dl)p.x=b.minx-r;else if(m===dr)p.x=b.maxx+r;
      else if(m===dn)p.z=b.minz-r;else p.z=b.maxz+r;
    }
  }
  // soft world bounds — the brush closes in around the corridor
  const px=pathX(p.z);
  p.x=clamp(p.x,px-34,px+34);
  const zMin = (Game.phase==="clearing"||Game.phase==="lost") ? -244 : -200;
  p.z=clamp(p.z,zMin,21);
}
let bestInteract=null;
function findInteract(){
  const p=Game.player;
  const fx=-Math.sin(p.yaw),fz=-Math.cos(p.yaw);
  let best=null,bs=-1;
  for(const it of interactables){
    if(!it.active&&it.type!=="read"&&it.type!=="radio")continue;
    if(it.type==="erase"&&!it.active)continue;
    if((it.type==="branch"||it.type==="paint")&&!it.active)continue;
    const dx=it.x-p.x,dz=it.z-p.z,d=Math.hypot(dx,dz);
    if(d>(it.r||2.2))continue;
    const dot=(dx*fx+dz*fz)/Math.max(d,0.001);
    if(d>0.7&&dot<0.45)continue;
    const score=dot-d*0.1;
    if(score>bs){bs=score;best=it;}
  }
  bestInteract=best;
  UI.prompt(best?best.prompt:"");
}
function update(dt){
  const p=Game.player;
  // look
  const pad=Input.pad();
  const sens=0.0023;
  p.yaw  -= (Input.look.dx*sens + pad.lx*0.045);
  p.pitch-= (Input.look.dy*sens + pad.ly*0.04);
  p.pitch=clamp(p.pitch,-1.25,1.25);
  Input.look.dx=0;Input.look.dy=0;
  // move
  let mx=0,mz=0;
  if(Input.held.has("up"))mz-=1; if(Input.held.has("down"))mz+=1;
  if(Input.held.has("left"))mx-=1; if(Input.held.has("right"))mx+=1;
  mx+=Input.stick.x+pad.mx; mz+=Input.stick.y+pad.mz;
  const ml=Math.hypot(mx,mz); if(ml>1){mx/=ml;mz/=ml;}
  const sp=3.1;
  const sy=Math.sin(p.yaw),cy=Math.cos(p.yaw);
  p.x+=(-sy*-mz + cy*mx)*sp*dt;
  p.z+=(-cy*-mz - sy*mx)*sp*dt;
  resolveCollisions();
  // head bob + footsteps
  const moving=ml>0.15;
  if(moving){
    p.bob+=dt*7.5; p.stepAcc+=dt*ml;
    if(p.stepAcc>0.58){p.stepAcc=0;AudioSys.footstep();}
  } else p.bob=lerp(p.bob,Math.round(p.bob/Math.PI)*Math.PI,dt*6);
  // interaction
  if(pad.A)Input.interact=true;
  if(pad.B)Input.flash=true;
  if(Input.consumeFlash()){ Game.flashOn=!Game.flashOn;
    flashlight.intensity=Game.flashOn?3.8:0;
    AudioSys.staticBurst(0.04,0.07); }
  if(Input.consumeInteract()){
    if(Game.state==="reading"){UI.closeRead();}
    else if(bestInteract){
      if(bestInteract.text!==undefined){ UI.read(bestInteract.text); bestInteract.use&&bestInteract.use(); }
      else bestInteract.use&&bestInteract.use();
    }
  }
  // triggers
  for(const tr of Triggers){
    if(tr.fired)continue;
    if(tr.cond&&!tr.cond())continue;
    if(Math.hypot(tr.x-p.x,tr.z-p.z)<tr.r){ tr.fn(); if(tr.once!==false)tr.fired=true; }
  }
  // shed→outpost phase advance also unlocks on proximity (light exploration friendly)
  if(Game.phase==="intro"){ /* handled by tasks */ }
  // anims
  for(let i=Anim.length-1;i>=0;i--){const a=Anim[i];a.t+=dt;const k=Math.min(a.t/a.dur,1);
    a.fn(k); if(k>=1){a.end&&a.end();Anim.splice(i,1);} }
  Glimpse.tick();
  ShadowWalkers.tick(dt);
  if(Game.state==="play"){
    Game.timecode+=dt*30; // lazy evening clock
  }
}
function render(){
  const p=Game.player;
  if(skyDome) skyDome.position.set(p.x,0,p.z);
  if(Game.hasMap) UI.drawMinimap();
  const bobY=Math.sin(p.bob)*0.045, bobX=Math.cos(p.bob*0.5)*0.02;
  camera.position.set(p.x+bobX,p.y+bobY,p.z);
  camera.rotation.order="YXZ";
  camera.rotation.y=p.yaw; camera.rotation.x=p.pitch;
  // flashlight follows with slight lag
  flashlight.position.copy(camera.position);
  const fwd=new THREE.Vector3(0,0,-1).applyEuler(camera.rotation);
  flashTarget.position.copy(camera.position).addScaledVector(fwd,8);
  renderer.render(scene,camera);
}

/* ============================ boot / loop ============================ */
async function boot(){
  $("h1").textContent=STR.title;
  $("h2").textContent=STR.subtitle;
  $("beginbtn").textContent=STR.loading;
  $("ctl").textContent=IS_TOUCH?STR.controlsTouch:STR.controlsDesktop;
  initRenderer(); Input.init($("c")); buildTextures(); buildMaterials();
  const curve=buildPathLookup();
  buildGroundAndPath(curve);
  await loadTreeMesh();
  await loadBuildingMeshes();
  await loadBushMesh();
  await loadLogMesh();
  const trees=buildTrees();
  buildBushes();
  buildGrass();
  padBackdropCorners();
  buildParkingLot();
  buildTrailhead(); buildShed(); buildOutpost(); buildBridge(); buildCabin(); buildFigure();
  buildBranches(); buildWhiteMarkers(trees); buildRedMarkers(trees);
  buildAbandonedClearing(); ShadowWalkers.build();
  UI.refresh(); UI.clock();
  $("beginbtn").textContent=STR.begin;
  Game.state="start";
  const begin=async()=>{
    if(Game.state!=="start")return; Game.state="starting";
    $("start").style.display="none";
    // pointer lock MUST be requested inside the user gesture, before any await,
    // or the browser silently refuses it
    if(HAS_MOUSE) $("c").requestPointerLock?.();
    Game.state="play"; UI.fadeIn();
    // startup hint so players know to turn on the flashlight (toast self-fades)
    setTimeout(()=>{ if(Game.state==="play" && !Game.flashOn) UI.toast(STR.hintFlashlight); }, 1400);
    if(!AudioSys.ready) await AudioSys.init();
    AudioSys.ctx.resume();
    AudioSys.setWind(0.30,4); AudioSys.setCrickets(0.5,6);
  };
  $("start").addEventListener("click",begin);
  $("start").addEventListener("touchend",e=>{e.preventDefault();begin();},{passive:false});
}
let acc=0,last=performance.now(),frames=0,fpsAt=last;
const STEP=1000/60;
let paused=false;
// Pause ONLY when the tab is genuinely hidden. Do NOT pause on window blur —
// requesting pointer lock fires a blur event, which would freeze the game the
// instant the player clicks to look around.
document.addEventListener("visibilitychange",()=>{
  paused=document.hidden;
  if(!paused)last=performance.now();
});
if(DEV)$("dev").style.display="block";
function frame(now){
  requestAnimationFrame(frame);
  if(paused)return;
  acc+=now-last; last=now;
  if(acc>250)acc=250;
  if(Game.state==="play"||Game.state==="reading"||Game.state==="ended"){
    while(acc>=STEP){ if(Game.state==="play")update(STEP/1000);
      else { // anims still run during reads/endings
        for(let i=Anim.length-1;i>=0;i--){const a=Anim[i];a.t+=STEP/1000;const k=Math.min(a.t/a.dur,1);
          a.fn(k); if(k>=1){a.end&&a.end();Anim.splice(i,1);} }
      }
      acc-=STEP; }
    if(Game.state==="play"){
      if(HAS_MOUSE && !Input.locked) UI.prompt(STR.clickToLook||"Click to look around");
      else findInteract();
    } else UI.prompt("");
    UI.clock();
    render();
  } else { acc=0; }
  if(DEV&&(frames++,now-fpsAt>=500)){
    $("dev").textContent=Math.round(frames*1000/(now-fpsAt))+" fps · "+renderer.info.render.calls+" dc";
    frames=0;fpsAt=now;
  }
}
boot();
requestAnimationFrame(frame);
