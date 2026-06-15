import * as THREE from 'https://unpkg.com/three@0.160.0/build/three.module.js';

const WORLD_ID = Number(document.body.dataset.worldId);
const socket = io();

const scene = new THREE.Scene();
scene.background = new THREE.Color(0xb96532);
scene.fog = new THREE.Fog(0xb96532, 45, 230);

const camera = new THREE.PerspectiveCamera(76, innerWidth / innerHeight, 0.1, 1000);
const renderer = new THREE.WebGLRenderer({ antialias: false, powerPreference:'high-performance' });
renderer.setPixelRatio(Math.min(0.9, window.devicePixelRatio || 1));
renderer.setSize(innerWidth, innerHeight);
renderer.shadowMap.enabled = false;
// Performance-first renderer: no heavy shadows, limited pixel ratio, and only nearby ore meshes are drawn.
document.body.appendChild(renderer.domElement);

const clock = new THREE.Clock();
const ray = new THREE.Raycaster();
const center = new THREE.Vector2(0, 0);

const keys = {};
const others = {};
let yaw = 0, pitch = 0;
let firstPerson = true;
let velocityY = 0, grounded = true;
let toolIndex = 0;
let mining = null;
let inventoryOpen = false, buildOpen = false;
let inventory = [];
let survival = {health:100, food:100, water:100, oxygen:100, x:0, z:5};
let state = {};
let lastEmit = 0, lastSave = 0;
const toolModes = ['Mining Mode', 'Building Mode', 'Deconstruction Mode', 'Scanner Mode'];
const activeNodes = new Map();
let allNodeData = [];
let lastNodeCull = 0;
const MAX_RENDERED_NODES = 70;
const NODE_RENDER_DISTANCE = 72;
const buildings = [];

const ORE_TIMES = {iron:3,titanium:4,silicon:3,magnesium:3,cobalt:3,ice:2,aluminum:5,iridium:6,uranium:6,sulfur:5,osmium:7,super_alloy:7,zeolite:8,pulsar_quartz:10};
const ORE_COLORS = {iron:0x7d3424,titanium:0x74879a,silicon:0xd8d5c8,magnesium:0x30343a,cobalt:0x126bff,ice:0x9ee8ff,aluminum:0xdce4ec,iridium:0xff5b25,uranium:0x67ff40,sulfur:0xe4c43a,osmium:0x1e5aa7,super_alloy:0xff9a3c,zeolite:0xdff4d0,pulsar_quartz:0xd56cff};
const ORE_RARITY = {iron:'Common',titanium:'Common',silicon:'Common',magnesium:'Common',cobalt:'Common',ice:'Early',aluminum:'Advanced',iridium:'Rare',uranium:'Rare',sulfur:'Advanced',osmium:'Rare',super_alloy:'Rare',zeolite:'Late Game',pulsar_quartz:'Late Game'};
const ORE_GLOW = new Set(['cobalt','ice','iridium','uranium','osmium','super_alloy','zeolite','pulsar_quartz']);
let containerOpen = false;
let activeContainerKey = null;
let activeContainerInventory = [];
const containers = new Map();
const interactables = [];
let podDoorMesh = null;
let podDoorTargetOpen = false;
let podInteriorLight = null;
let stationDoorMeshes = [];

function cap(s){ return String(s||'').replace(/_/g,' ').replace(/\b\w/g, c=>c.toUpperCase()); }
function mat(color, emissive=0, metal=.25, rough=.55){ return new THREE.MeshStandardMaterial({color, roughness:rough, metalness:metal, emissive:color, emissiveIntensity:emissive}); }
function makeNoiseTexture(base='#a25535', speck='#6f3327', size=256){
  const c=document.createElement('canvas'); c.width=c.height=size; const ctx=c.getContext('2d');
  ctx.fillStyle=base; ctx.fillRect(0,0,size,size);
  for(let i=0;i<3600;i++){ const a=Math.random()*.22; ctx.fillStyle=`rgba(${parseInt(speck.slice(1,3),16)},${parseInt(speck.slice(3,5),16)},${parseInt(speck.slice(5,7),16)},${a})`; ctx.fillRect(Math.random()*size,Math.random()*size,1+Math.random()*2,1+Math.random()*2); }
  for(let i=0;i<42;i++){ ctx.strokeStyle='rgba(255,178,95,.07)'; ctx.beginPath(); const y=Math.random()*size; ctx.moveTo(0,y); ctx.bezierCurveTo(size*.3,y+Math.random()*18-9,size*.7,y+Math.random()*18-9,size,y+Math.random()*18-9); ctx.stroke(); }
  const t=new THREE.CanvasTexture(c); t.wrapS=t.wrapT=THREE.RepeatWrapping; t.repeat.set(22,22); t.colorSpace=THREE.SRGBColorSpace; return t;
}
function makeMetalTexture(base='#9aa4ad', grime='#111820', size=256){
  const c=document.createElement('canvas'); c.width=c.height=size; const ctx=c.getContext('2d'); ctx.fillStyle=base; ctx.fillRect(0,0,size,size);
  for(let i=0;i<32;i++){ ctx.strokeStyle=i%3?'rgba(15,24,34,.35)':'rgba(255,255,255,.18)'; ctx.lineWidth=1+Math.random()*2; const x=Math.random()*size,y=Math.random()*size; ctx.strokeRect(x,y,35+Math.random()*80,20+Math.random()*50); }
  for(let i=0;i<1000;i++){ ctx.fillStyle=Math.random()>.65?'rgba(0,0,0,.16)':'rgba(255,255,255,.08)'; ctx.fillRect(Math.random()*size,Math.random()*size,1,1); }
  const t=new THREE.CanvasTexture(c); t.wrapS=t.wrapT=THREE.RepeatWrapping; t.repeat.set(2.5,2.5); t.colorSpace=THREE.SRGBColorSpace; return t;
}
const texLoader = new THREE.TextureLoader();
const oreTextureCache = {};
function oreIconPath(item){ return Object.prototype.hasOwnProperty.call(ORE_COLORS, item) ? `/static/assets/ores/${item}.png` : null; }
function oreTexture(item){
  if(!oreIconPath(item)) return null;
  if(!oreTextureCache[item]){
    const t = texLoader.load(oreIconPath(item));
    t.colorSpace = THREE.SRGBColorSpace;
    oreTextureCache[item] = t;
  }
  return oreTextureCache[item];
}
function msg(t){ const el=document.getElementById('tutorial'); if(el) el.textContent='NOVA: '+t; }
function clamp(v,a,b){ return Math.max(a, Math.min(b, v)); }
function fallbackIconData(item){
  const color = {food_ration:0xd59b5b,water_bottle:0x5db7ff,oxygen_capsule:0x85f7ff,battery_cell:0xffd858}[item] || 0x9bb3d5;
  const c=document.createElement('canvas'); c.width=96; c.height=96; const ctx=c.getContext('2d');
  const hex='#'+color.toString(16).padStart(6,'0');
  ctx.clearRect(0,0,96,96); const grd=ctx.createRadialGradient(46,34,5,48,48,46); grd.addColorStop(0,'#ffffff'); grd.addColorStop(.25,hex); grd.addColorStop(1,'#111827');
  ctx.fillStyle=grd; ctx.beginPath(); const pts=[[47,9],[75,26],[82,58],[57,83],[24,76],[11,46],[25,17]]; pts.forEach((p,i)=>i?ctx.lineTo(p[0],p[1]):ctx.moveTo(p[0],p[1])); ctx.closePath(); ctx.fill();
  ctx.strokeStyle='rgba(255,255,255,.85)'; ctx.lineWidth=3; ctx.stroke(); ctx.fillStyle='white'; ctx.font='bold 14px Arial'; ctx.textAlign='center'; ctx.fillText(cap(item).split(' ')[0].slice(0,8),48,92); return c.toDataURL();
}
function itemSlotHtml(item){
  if(!item) return '<em>Empty</em>';
  const src = oreIconPath(item) || fallbackIconData(item);
  return `<img class="item-icon" src="${src}" title="${cap(item)}"><span>${cap(item)}</span>`;
}

// Deterministic terrain height. Player movement uses the same function, so hills are solid and walkable.
function terrainHeight(x,z){
  const h = Math.sin(x*.055)*1.8 + Math.cos(z*.047)*1.5 + Math.sin((x+z)*.028)*1.1;
  const crater = Math.max(0, 1 - Math.hypot(x+12,z+45)/42) * -3.5;
  return h + crater;
}
function terrainSlope(x,z){
  const e=.8;
  const dx=Math.abs(terrainHeight(x+e,z)-terrainHeight(x-e,z))/(e*2);
  const dz=Math.abs(terrainHeight(x,z+e)-terrainHeight(x,z-e))/(e*2);
  return Math.hypot(dx,dz);
}

const sun = new THREE.DirectionalLight(0x9beaff, 1.4);
sun.position.set(60, 85, 35); sun.castShadow = true; scene.add(sun);
scene.add(new THREE.AmbientLight(0x425b7a, .82));
const moon = new THREE.Mesh(new THREE.SphereGeometry(5, 32, 32), mat(0xa9c7ff,.15));
moon.position.set(-90,70,-130); scene.add(moon);

const groundGeo = new THREE.PlaneGeometry(340, 340, 90, 90);
groundGeo.rotateX(-Math.PI/2);
for(let i=0;i<groundGeo.attributes.position.count;i++){
  const x=groundGeo.attributes.position.getX(i), z=groundGeo.attributes.position.getZ(i);
  groundGeo.attributes.position.setY(i, terrainHeight(x,z));
}
groundGeo.computeVertexNormals();
const ground = new THREE.Mesh(groundGeo, new THREE.MeshStandardMaterial({color:0xffffff, map:makeNoiseTexture('#a45b36','#4a2b24'), roughness:1}));
ground.receiveShadow = true; scene.add(ground);

// Scatter small terrain rocks that are solid landmarks.
const collisionCircles = [];
function addCollision(x,z,r){ collisionCircles.push({x,z,r}); }
function addRock(x,z,r=1.2){
  const mesh=new THREE.Mesh(new THREE.DodecahedronGeometry(r,0), mat(0x5b5651));
  mesh.position.set(x, terrainHeight(x,z)+r*.42, z); mesh.scale.y=.65; mesh.castShadow=true; scene.add(mesh); addCollision(x,z,r*.8); return mesh;
}
for(let i=0;i<16;i++){ const a=Math.random()*Math.PI*2, d=20+Math.random()*130; addRock(Math.cos(a)*d, Math.sin(a)*d, .55+Math.random()*1.05); }

function addLabel(text, y=3.1){
  const c=document.createElement('canvas'); c.width=256; c.height=64; const ctx=c.getContext('2d');
  ctx.fillStyle='rgba(0,8,20,.78)'; ctx.fillRect(0,0,256,64); ctx.fillStyle='#e9fbff'; ctx.font='bold 24px Arial'; ctx.textAlign='center'; ctx.fillText(text,128,40);
  const s=new THREE.Sprite(new THREE.SpriteMaterial({map:new THREE.CanvasTexture(c), transparent:true})); s.position.y=y; s.scale.set(3.4,.85,1); return s;
}
function astronaut(color=0xe9fbff, username='Player'){
  const g=new THREE.Group(), suit=mat(color), dark=mat(0x172436), visor=mat(0x071826,.18), glow=mat(0x4dfcff,.45);
  const torso=new THREE.Mesh(new THREE.CapsuleGeometry(.45,1.0,6,10), suit); torso.position.y=1.35; torso.castShadow=true; g.add(torso);
  const head=new THREE.Mesh(new THREE.SphereGeometry(.43,18,18), suit); head.position.y=2.18; head.castShadow=true; g.add(head);
  const visorMesh=new THREE.Mesh(new THREE.SphereGeometry(.31,18,10,0,Math.PI*2,0,Math.PI/2), visor); visorMesh.position.set(0,.02,2.22); visorMesh.rotation.x=Math.PI/2; visorMesh.scale.z=.38; g.add(visorMesh);
  const pack=new THREE.Mesh(new THREE.BoxGeometry(.64,.95,.28), dark); pack.position.set(0,1.42,.44); pack.castShadow=true; g.add(pack);
  const lamp=new THREE.Mesh(new THREE.SphereGeometry(.06,8,8), glow); lamp.position.set(.32,1.84,-.32); g.add(lamp);
  const arms=[], legs=[];
  for(const side of [-1,1]){
    const arm=new THREE.Mesh(new THREE.CapsuleGeometry(.13,.75,4,8), suit); arm.position.set(side*.58,1.43,0); arm.rotation.z=side*.18; arm.castShadow=true; g.add(arm); arms.push(arm);
    const leg=new THREE.Mesh(new THREE.CapsuleGeometry(.16,.8,4,8), suit); leg.position.set(side*.2,.55,0); leg.castShadow=true; g.add(leg); legs.push(leg);
    const boot=new THREE.Mesh(new THREE.BoxGeometry(.28,.14,.46), dark); boot.position.set(side*.2,.08,-.04); boot.castShadow=true; g.add(boot);
  }
  g.add(addLabel(username)); g.userData={arms,legs,runPhase:0}; return g;
}
function poseAstronaut(g,moving,running,dt){
  if(!g.userData.arms) return; if(moving) g.userData.runPhase += dt*(running?14:8);
  const swing = moving ? Math.sin(g.userData.runPhase)*((running ? .78 : .42)) : 0;
  g.userData.arms[0].rotation.x=swing; g.userData.arms[1].rotation.x=-swing;
  g.userData.legs[0].rotation.x=-swing; g.userData.legs[1].rotation.x=swing;
}
const player = astronaut(0xffffff,'You'); scene.add(player); player.position.set(0, terrainHeight(0,5), 5);

// Realistic futuristic mining gun in first person.
const firstPersonTool = new THREE.Group(); firstPersonTool.position.set(.32,-.34,-.78); firstPersonTool.rotation.set(-.04,-.12,.02);
const gunDark=mat(0x101927), gunMetal=mat(0x5f748c), gunPanel=mat(0x21364d), gunGlow=mat(0x4dfcff,.7), warn=mat(0xffc857,.25);
function mesh(geo,ma,x,y,z){ const m=new THREE.Mesh(geo,ma); m.position.set(x,y,z); firstPersonTool.add(m); return m; }
const grip=mesh(new THREE.BoxGeometry(.16,.48,.18),gunDark,.02,-.16,.18); grip.rotation.x=.28;
mesh(new THREE.BoxGeometry(.34,.22,.72),gunMetal,0,0,-.12);
const core=mesh(new THREE.CylinderGeometry(.075,.075,.38,18),gunGlow,.19,.03,-.14); core.rotation.z=Math.PI/2;
mesh(new THREE.BoxGeometry(.22,.018,.18),gunGlow,-.02,.125,.08);
mesh(new THREE.BoxGeometry(.22,.26,.34),gunPanel,-.02,-.02,.32);
const barrelBase=mesh(new THREE.CylinderGeometry(.105,.14,.38,20),gunMetal,0,0,-.58); barrelBase.rotation.x=Math.PI/2;
const barrel=mesh(new THREE.CylinderGeometry(.045,.07,.55,20),gunDark,0,0,-.98); barrel.rotation.x=Math.PI/2;
const muzzle=mesh(new THREE.CylinderGeometry(.09,.12,.12,24),gunGlow,0,0,-1.31); muzzle.rotation.x=Math.PI/2;
const rail=mesh(new THREE.BoxGeometry(.38,.045,.78),warn,0,.16,-.21);
const miningBeam=mesh(new THREE.CylinderGeometry(.018,.035,7.5,14),mat(0x4dfcff,.9),0,0,-5.1); miningBeam.rotation.x=Math.PI/2; miningBeam.visible=false;
const beamPulse=new THREE.PointLight(0x4dfcff,0,8); beamPulse.position.set(0,0,-1.45); firstPersonTool.add(beamPulse);
camera.add(firstPersonTool); scene.add(camera);
const sparkGroup=new THREE.Group(); scene.add(sparkGroup);
function spawnSparks(target){ if(!target) return; for(let i=0;i<5;i++){ const s=new THREE.Mesh(new THREE.SphereGeometry(.03,6,6), mat(i%2?0x4dfcff:0xfff2a8,.7)); s.position.copy(target.position).add(new THREE.Vector3((Math.random()-.5)*.45,.05+Math.random()*.25,(Math.random()-.5)*.45)); s.userData={life:.25+Math.random()*.25, vel:new THREE.Vector3((Math.random()-.5)*.04,.02+Math.random()*.04,(Math.random()-.5)*.04)}; sparkGroup.add(s); } }
function updateGun(active,dt,target){ const pulse=active?(Math.sin(performance.now()*.028)*.5+.5):0; miningBeam.visible=active; beamPulse.intensity=active?1.4+pulse*2.2:0; muzzle.scale.setScalar(active?1+pulse*.35:1); firstPersonTool.position.z=active?-.78+Math.sin(performance.now()*.045)*.025:-.78; if(active&&Math.random()<.35) spawnSparks(target); for(const s of [...sparkGroup.children]){ s.userData.life-=dt; s.position.add(s.userData.vel); if(s.userData.life<=0) sparkGroup.remove(s); } }

// Detailed rounded escape pod: Planet-Crafter-inspired emergency lifeboat with enterable interior.
function makeEscapePod(){
  const g=new THREE.Group();
  const y=terrainHeight(0,0);
  const hull=new THREE.MeshStandardMaterial({color:0xffffff,map:makeMetalTexture('#d7d6cc','#6f6d65'),roughness:.34,metalness:.55});
  const dark=new THREE.MeshStandardMaterial({color:0xffffff,map:makeMetalTexture('#111923','#05070b'),roughness:.46,metalness:.55});
  const orange=new THREE.MeshStandardMaterial({color:0xffffff,map:makeMetalTexture('#d46f2f','#562a17'),roughness:.38,metalness:.45,emissive:0xd46f2f,emissiveIntensity:.04});
  const glass=mat(0x79eaff,.35,.18,.16), black=mat(0x080b10,0,.45,.55), scorch=mat(0x18120d,0,.1,.8), glow=mat(0x9beaff,.65,.1,.2);

  // Main capsule: rounded truncated cone, much closer to a real evacuation pod than a cube.
  const main=new THREE.Mesh(new THREE.CylinderGeometry(2.25,3.05,3.55,32,5), hull); main.position.set(0,y+2.05,0); main.castShadow=true; g.add(main);
  const top=new THREE.Mesh(new THREE.CylinderGeometry(1.25,2.25,.72,32,2), hull); top.position.set(0,y+4.18,0); top.castShadow=true; g.add(top);
  const cap=new THREE.Mesh(new THREE.SphereGeometry(1.25,32,12,0,Math.PI*2,0,Math.PI/2), hull); cap.position.set(0,y+4.52,0); cap.scale.y=.38; cap.castShadow=true; g.add(cap);
  const heat=new THREE.Mesh(new THREE.CylinderGeometry(3.14,2.8,.38,32), black); heat.position.set(0,y+.18,0); heat.castShadow=true; g.add(heat);

  // Orange band and panel seams.
  const band1=new THREE.Mesh(new THREE.TorusGeometry(2.72,.055,8,64), orange); band1.position.set(0,y+1.25,0); band1.rotation.x=Math.PI/2; g.add(band1);
  const band2=new THREE.Mesh(new THREE.TorusGeometry(2.18,.045,8,64), orange); band2.position.set(0,y+3.25,0); band2.rotation.x=Math.PI/2; g.add(band2);
  for(let i=0;i<32;i++){
    const a=i*Math.PI*2/32;
    const seam=new THREE.Mesh(new THREE.BoxGeometry(.025,2.65,.035), i%4?dark:orange);
    seam.position.set(Math.cos(a)*2.42,y+2.28,Math.sin(a)*2.42); seam.rotation.y=-a; g.add(seam);
  }

  // Windows around the front arc.
  for(const a of [-.65,-.32,0,.32,.65]){
    const win=new THREE.Mesh(new THREE.BoxGeometry(.55,.82,.035), glass);
    win.position.set(Math.sin(a)*2.25,y+2.75,-Math.cos(a)*2.25); win.rotation.y=a; win.castShadow=true; g.add(win);
    const frame=new THREE.Mesh(new THREE.BoxGeometry(.70,.98,.045), dark);
    frame.position.set(Math.sin(a)*2.255,y+2.75,-Math.cos(a)*2.255); frame.rotation.y=a; g.add(frame); win.position.z-=.015;
  }

  // Automatic airlock door at the front. It slides down/out of the way when close.
  const doorFrame=new THREE.Mesh(new THREE.BoxGeometry(1.45,1.95,.16), dark); doorFrame.position.set(0,y+1.82,-2.72); doorFrame.castShadow=true; g.add(doorFrame);
  podDoorMesh=new THREE.Mesh(new THREE.BoxGeometry(1.05,1.48,.18), hull);
  podDoorMesh.position.set(0,y+1.74,-2.84); podDoorMesh.castShadow=true;
  podDoorMesh.userData={closedY:y+1.74, openY:y+.42, closedZ:-2.84, openZ:-3.05}; g.add(podDoorMesh);
  const doorWindow=new THREE.Mesh(new THREE.BoxGeometry(.38,.55,.03), glass); doorWindow.position.set(0,y+1.95,-2.955); g.add(doorWindow);

  // Interior area just inside the door.
  const floor=new THREE.Mesh(new THREE.CylinderGeometry(2.08,2.42,.12,24), mat(0x2a3342,.02,.45,.45)); floor.position.set(0,y+.42,-.42); floor.scale.z=.72; floor.castShadow=true; g.add(floor);
  podInteriorLight=new THREE.PointLight(0x9beaff,2.0,10); podInteriorLight.position.set(0,y+2.5,-.55); g.add(podInteriorLight);
  const chair=new THREE.Mesh(new THREE.BoxGeometry(.8,1.05,.72), mat(0x202a38)); chair.position.set(0,y+1.08,.35); chair.castShadow=true; g.add(chair);
  const headrest=new THREE.Mesh(new THREE.BoxGeometry(.75,.42,.24), mat(0x151c28)); headrest.position.set(0,y+1.82,.54); g.add(headrest);
  const bunk=new THREE.Mesh(new THREE.BoxGeometry(1.45,.28,.55), mat(0x3d4859)); bunk.position.set(1.05,y+.82,-.22); bunk.rotation.y=-.35; bunk.castShadow=true; g.add(bunk);
  const nova=new THREE.Mesh(new THREE.BoxGeometry(.65,.95,.12), black); nova.position.set(-1.15,y+1.42,-.55); nova.rotation.y=.35; nova.castShadow=true; nova.userData={name:'NOVA Terminal', targetType:'computer'}; g.add(nova); interactables.push(nova);
  const screen=new THREE.Mesh(new THREE.PlaneGeometry(.48,.62), glass); screen.position.set(-1.18,y+1.44,-.64); screen.rotation.y=.35; screen.userData=nova.userData; g.add(screen);
  const screenGlow=new THREE.PointLight(0x4dfcff, .9, 4); screenGlow.position.set(-1.22,y+1.45,-.72); g.add(screenGlow);

  // Only interactable object in the pod: storage crate.
  const crate=new THREE.Group(); crate.position.set(.78,y+.74,-1.05); crate.rotation.y=-.18;
  const crateBody=new THREE.Mesh(new THREE.BoxGeometry(1.05,.62,.72), mat(0x9b6a3f,.02,.25,.55)); crateBody.castShadow=true; crate.add(crateBody);
  const crateLid=new THREE.Mesh(new THREE.BoxGeometry(1.12,.09,.78), dark); crateLid.position.y=.36; crate.add(crateLid);
  const crateLight=new THREE.Mesh(new THREE.BoxGeometry(.75,.035,.04), glow); crateLight.position.set(0,.15,-.38); crate.add(crateLight);
  crate.userData={name:'Emergency Supply Crate', targetType:'container', containerKey:'escape_pod_crate'};
  crate.traverse(o=>o.userData=crate.userData); g.add(crate); containers.set('escape_pod_crate', crate); interactables.push(crate);

  // Thrusters, landing legs, antennas, lights, rivets, scorch marks.
  for(let i=0;i<6;i++){ const a=i*Math.PI*2/6; const leg=new THREE.Group(); leg.position.set(Math.cos(a)*2.55,y+.45,Math.sin(a)*2.55); leg.rotation.y=-a; const strut=new THREE.Mesh(new THREE.CylinderGeometry(.055,.08,1.15,10), dark); strut.rotation.z=.55; strut.castShadow=true; leg.add(strut); const foot=new THREE.Mesh(new THREE.BoxGeometry(.68,.08,.36), dark); foot.position.set(.28,-.55,0); foot.castShadow=true; leg.add(foot); g.add(leg); }
  for(let i=0;i<4;i++){ const a=i*Math.PI*2/4+Math.PI/4; const thr=new THREE.Mesh(new THREE.CylinderGeometry(.22,.32,.42,16), black); thr.position.set(Math.cos(a)*1.25,y+.02,Math.sin(a)*1.25); thr.rotation.x=Math.PI/2; g.add(thr); const blue=new THREE.PointLight(0x70d8ff,.7,5); blue.position.copy(thr.position); g.add(blue); }
  for(let i=0;i<42;i++){ const a=Math.random()*Math.PI*2; const r=1.55+Math.random()*1.2; const riv=new THREE.Mesh(new THREE.SphereGeometry(.035,6,6), dark); riv.position.set(Math.cos(a)*r,y+1.0+Math.random()*2.8,Math.sin(a)*r); g.add(riv); }
  for(let i=0;i<16;i++){ const a=-1.1+Math.random()*2.2; const sc=new THREE.Mesh(new THREE.PlaneGeometry(.35+Math.random()*.5,.12+Math.random()*.22), scorch); sc.position.set(Math.sin(a)*(2.6+Math.random()*.08),y+1.1+Math.random()*2.9,-Math.cos(a)*(2.6+Math.random()*.08)); sc.rotation.y=a; sc.rotation.z=Math.random()*Math.PI; g.add(sc); }
  const beacon=new THREE.Mesh(new THREE.SphereGeometry(.12,14,14), mat(0xff3344,.75)); beacon.position.set(0,y+4.95,0); g.add(beacon); const bl=new THREE.PointLight(0xff3344,1.1,9); bl.position.copy(beacon.position); g.add(bl);
  // Collision is split around the shell so the front hatch and interior stay enterable.
  addCollision(-2.65,0,.9); addCollision(2.65,0,.9); addCollision(0,2.25,1.25);
  return g;
}
scene.add(makeEscapePod());
const podInteriorMarker = new THREE.Mesh(new THREE.TorusGeometry(1.75,.035,6,48), mat(0x4dfcff,.35)); podInteriorMarker.rotation.x=Math.PI/2; podInteriorMarker.position.set(0,terrainHeight(0,0)+.09,-.55); scene.add(podInteriorMarker);

// Crashed colony station: detailed broken orbital station, not cubes.
function makeCrashStation(){
  const g=new THREE.Group(); g.position.set(0,0,-58);
  const metal=new THREE.MeshStandardMaterial({color:0xffffff,map:makeMetalTexture('#9aa4ad','#252d35'),roughness:.36,metalness:.62});
  const dark=new THREE.MeshStandardMaterial({color:0xffffff,map:makeMetalTexture('#111820','#05070b'),roughness:.46,metalness:.55});
  const black=mat(0x05070b,0,.4,.6), orange=mat(0xd56f32,.18,.4,.42), blue=mat(0x4dfcff,.45,.15,.25), fireMat=mat(0xff6b37,.7,.15,.4);
  const y=terrainHeight(0,-58)+2.3;
  // Huge broken habitation ring, like the reference.
  const ring=new THREE.Group(); ring.position.set(-8,y+3,0); ring.rotation.set(.52,.18,.26);
  for(let i=0;i<48;i++){
    const a=i*Math.PI*2/48;
    if(i>8 && i<15) continue; // missing destroyed section
    const seg=new THREE.Mesh(new THREE.BoxGeometry(1.7,.54,.72), i%4?metal:dark);
    seg.position.set(Math.cos(a)*9.2,Math.sin(a)*9.2,0); seg.rotation.z=a; seg.castShadow=true; ring.add(seg);
    if(i%5===0){ const win=new THREE.Mesh(new THREE.BoxGeometry(.72,.06,.78), blue); win.position.copy(seg.position); win.position.z=-.42; win.rotation.z=a; ring.add(win); }
  }
  g.add(ring);
  // Main cylindrical station spine, broken into modules.
  for(let i=0;i<6;i++){
    const module=new THREE.Mesh(new THREE.CylinderGeometry(2.25,2.25,5.2,24), i%2?metal:dark);
    module.rotation.z=Math.PI/2; module.rotation.y=.1; module.position.set(-2+i*4.4,y+1.1+Math.sin(i)*.45,-.5+i*.25); module.castShadow=true; g.add(module);
    const rimA=new THREE.Mesh(new THREE.TorusGeometry(2.28,.08,8,36), dark); rimA.rotation.x=Math.PI/2; rimA.position.set(module.position.x-2.5,module.position.y,module.position.z); g.add(rimA);
    const rimB=rimA.clone(); rimB.position.x=module.position.x+2.5; g.add(rimB);
  }
  // Torn open ends.
  for(const x of [-7.2,22.5]){ const torn=new THREE.Mesh(new THREE.TorusGeometry(2.45,.25,10,32), black); torn.rotation.y=Math.PI/2; torn.position.set(x,y+1.1,x>0?1.1:-.8); torn.scale.set(1,.78,1); g.add(torn); }
  // Command and cargo shells use cylinders/rounded forms, not boxes.
  const command=new THREE.Mesh(new THREE.CylinderGeometry(1.8,2.45,4.2,18), metal); command.position.set(-18,y+1.5,-2.5); command.rotation.set(.1,.7,Math.PI/2); command.castShadow=true; g.add(command);
  const cargo=new THREE.Mesh(new THREE.CylinderGeometry(2.1,2.1,6.5,18), metal); cargo.position.set(16,y+.65,4.2); cargo.rotation.set(.2,-.55,Math.PI/2); cargo.castShadow=true; g.add(cargo);
  // Debris field: curved plates, pipes, antennas.
  for(let i=0;i<38;i++){
    const dx=-34+Math.random()*70, dz=-22+Math.random()*44;
    let geo = i%3===0 ? new THREE.CylinderGeometry(.06,.09,2+Math.random()*6,8) : (i%3===1 ? new THREE.TorusGeometry(.6+Math.random()*1.4,.04,6,18) : new THREE.BoxGeometry(.08+Math.random()*.18,.16+Math.random()*.4,1+Math.random()*4));
    const d=new THREE.Mesh(geo, i%4?metal:dark);
    d.position.set(dx, terrainHeight(dx,dz-58)+.35+Math.random()*1.5, dz); d.rotation.set(Math.random()*Math.PI,Math.random()*Math.PI,Math.random()*Math.PI); d.castShadow=true; g.add(d);
  }
  // Interior walkable-looking tunnels and lit airlock doors.
  for(const door of [{x:-20,z:-4,rot:-.5,name:'Command Airlock'},{x:6,z:5,rot:.05,name:'Cargo Airlock'},{x:19,z:-6,rot:.35,name:'Engineering Airlock'}]){
    const frame=new THREE.Mesh(new THREE.CylinderGeometry(1.28,1.28,.28,16), dark); frame.rotation.x=Math.PI/2; frame.rotation.z=door.rot; frame.position.set(door.x,terrainHeight(door.x,door.z-58)+1.55,door.z); g.add(frame);
    const dmesh=new THREE.Mesh(new THREE.BoxGeometry(1.45,2.1,.18), metal); dmesh.position.set(door.x,terrainHeight(door.x,door.z-58)+1.45,door.z-.12); dmesh.rotation.y=door.rot; dmesh.userData={baseY:dmesh.position.y,openY:dmesh.position.y+2.3,worldX:door.x,worldZ:door.z-58,name:door.name}; g.add(dmesh); stationDoorMeshes.push(dmesh);
    const l=new THREE.PointLight(0x4dfcff,1.1,7); l.position.set(door.x,terrainHeight(door.x,door.z-58)+2.8,door.z); g.add(l);
  }
  // Fires/smoke-like dark cones and sparks.
  for(let i=0;i<6;i++){ const x=-24+Math.random()*52,z=-16+Math.random()*32, yy=terrainHeight(x,z-58)+.9; const f=new THREE.Mesh(new THREE.ConeGeometry(.25+Math.random()*.25,1.2+Math.random()*.7,10), fireMat); f.position.set(x,yy,z); g.add(f); const p=new THREE.PointLight(0xff713d,1.5,12); p.position.copy(f.position); g.add(p); }
  for(const c of [{x:0,z:-58,r:13},{x:-12,z:-58,r:10},{x:16,z:-55,r:8},{x:-22,z:-62,r:7}]) addCollision(c.x,c.z,c.r);
  return g;
}
scene.add(makeCrashStation());


// Shared low-poly ore geometries/materials avoid creating hundreds of unique heavy meshes.
const SHARED_ORE_GEOMETRIES = {
  chunky: new THREE.DodecahedronGeometry(1,0),
  crystal: new THREE.OctahedronGeometry(1,0),
  spike: new THREE.ConeGeometry(.55,1.15,7),
  target: new THREE.SphereGeometry(1.85,8,6),
  dust: new THREE.CylinderGeometry(1,1.18,.035,14)
};
const SHARED_INVISIBLE = new THREE.MeshBasicMaterial({transparent:true, opacity:0, depthWrite:false});
const SHARED_ORE_MATS = {};
function getOreMat(res, brightKey='base'){
  const key=res+'_'+brightKey; if(SHARED_ORE_MATS[key]) return SHARED_ORE_MATS[key];
  const base=ORE_COLORS[res]||0xffffff; const c=new THREE.Color(base);
  if(brightKey==='light') c.lerp(new THREE.Color(0xffffff), .22); if(brightKey==='dark') c.lerp(new THREE.Color(0x05070b), .18);
  SHARED_ORE_MATS[key]=new THREE.MeshStandardMaterial({color:c, roughness:.38, metalness:(res==='aluminum'||res==='titanium')?.68:.34, emissive:c, emissiveIntensity:ORE_GLOW.has(res)?.16:.02});
  return SHARED_ORE_MATS[key];
}

function oreRockMaterial(res, brighten=0){
  const base=ORE_COLORS[res]||0xffffff;
  const c=new THREE.Color(base);
  if(brighten>0) c.lerp(new THREE.Color(0xffffff), brighten);
  if(brighten<0) c.lerp(new THREE.Color(0x05070b), -brighten);
  return new THREE.MeshStandardMaterial({color:c, roughness:.34, metalness:(res==='gold'||res==='aluminum'||res==='palladium'||res==='titanium')?.72:.38, emissive:c, emissiveIntensity:ORE_GLOW.has(res)?.22:.035});
}
function addOreFacet(g,res,geo,px,py,pz,scale,rot){
  const m=new THREE.Mesh(geo, oreRockMaterial(res, Math.random()*.28-.08));
  m.position.set(px,py,pz); m.scale.set(scale.x,scale.y,scale.z); m.rotation.set(rot.x,rot.y,rot.z); m.castShadow=true; m.userData=g.userData; g.add(m); return m;
}
function makeOreNode(node){
  const res=node.resource_type; const x=Number(node.x), z=Number(node.z);
  const g=new THREE.Group();
  g.userData={nodeId:node.id, resource:res, name:`${cap(res)} Deposit`, region:node.region_name||'Unknown Region'};
  const baseY=terrainHeight(x,z);
  const rarity=ORE_RARITY[res]||'Common';
  const size = rarity==='Late Game' ? .86 : rarity==='Rare' ? .72 : rarity==='Advanced' ? .64 : .56;

  // Large invisible hit target for reliable mining. The visible rock stays small and embedded.
  const hit=new THREE.Mesh(SHARED_ORE_GEOMETRIES.target, SHARED_INVISIBLE);
  hit.scale.set(1.15,.6,1.15); hit.position.y=.25; hit.userData=g.userData; g.add(hit);

  const isCrystal = ['silicon','cobalt','ice','iridium','uranium','osmium','zeolite','pulsar_quartz'].includes(res);
  const mainGeo = isCrystal ? SHARED_ORE_GEOMETRIES.crystal : SHARED_ORE_GEOMETRIES.chunky;
  const main=new THREE.Mesh(mainGeo, getOreMat(res,'base'));
  main.position.y=.16; main.scale.set(size*1.02,size*.44,size*.78); main.rotation.set(.25,Number(node.id)%6,.08); main.userData=g.userData; main.castShadow=false; g.add(main);

  // A few extra facets create an actual ore-rock shape without laggy high object counts.
  const pieces = rarity==='Rare'||rarity==='Late Game' ? 3 : 2;
  for(let i=0;i<pieces;i++){
    const a=i*Math.PI*2/pieces + (Number(node.id)%17)*.03; const sc=size*(.34+i*.04);
    const geo = isCrystal ? SHARED_ORE_GEOMETRIES.spike : SHARED_ORE_GEOMETRIES.chunky;
    const m=new THREE.Mesh(geo, getOreMat(res,i%2?'light':'dark'));
    m.position.set(Math.cos(a)*size*.34,.10+i*.03,Math.sin(a)*size*.28);
    m.scale.set(sc,sc*.45,sc*.85); m.rotation.set(.5+i*.3,a,.2); m.userData=g.userData; g.add(m);
  }
  // Ground-embedded dark base ring makes the node look dug into the terrain instead of floating.
  const dust=new THREE.Mesh(SHARED_ORE_GEOMETRIES.dust, mat(0x2b211d,0,.05,.9)); dust.scale.set(size*.78,1,size*.58); dust.position.y=.01; g.add(dust);
  if(ORE_GLOW.has(res) && rarity!=='Common'){
    const glow=new THREE.Mesh(new THREE.SphereGeometry(size*.33,8,6), new THREE.MeshBasicMaterial({color:ORE_COLORS[res]||0xffffff, transparent:true, opacity:.22}));
    glow.position.y=.34; g.add(glow);
  }
  g.position.set(x, baseY+.01, z); scene.add(g); activeNodes.set(String(node.id), g); return g;
}
async function loadNodes(){
  const r=await fetch(`/api/world/${WORLD_ID}/nodes`); const d=await r.json();
  if(!d.ok) return;
  allNodeData = d.nodes || [];
  updateVisibleNodes(true);
}
function updateVisibleNodes(force=false){
  const now=performance.now();
  if(!force && now-lastNodeCull<1100) return;
  lastNodeCull=now;
  const px=player.position.x, pz=player.position.z;
  const nearby = allNodeData
    .map(n=>({n, d:Math.hypot(Number(n.x)-px, Number(n.z)-pz)}))
    .filter(o=>o.d<NODE_RENDER_DISTANCE)
    .sort((a,b)=>a.d-b.d)
    .slice(0, MAX_RENDERED_NODES);
  const wanted=new Set(nearby.map(o=>String(o.n.id)));
  for(const [id,obj] of activeNodes){ if(!wanted.has(id)){ scene.remove(obj); activeNodes.delete(id); } }
  for(const {n} of nearby){ if(!activeNodes.has(String(n.id))) makeOreNode(n); }
}

function buildingMesh(type,x,z){
  const group=new THREE.Group(); group.position.set(x, terrainHeight(x,z), z); const c={solar:0x4dfcff,oxygen:0x77ff9a,water:0x4da0ff,habitat:0xe9fbff,greenhouse:0xb46cff,research:0xffcc66,beacon:0x75ff9b,biodome:0xb46cff}[type]||0x4dfcff;
  const m=mat(c,.18), dark=mat(0x132235);
  if(type==='solar'){ const panel=new THREE.Mesh(new THREE.BoxGeometry(3.5,.18,2),m); panel.position.y=.75; panel.rotation.x=-.35; group.add(panel); const pole=new THREE.Mesh(new THREE.CylinderGeometry(.08,.08,1,8),dark); pole.position.y=.45; group.add(pole); }
  else { const b=new THREE.Mesh(new THREE.BoxGeometry(1.8,1.3,1.8),m); b.position.y=.65; b.castShadow=true; group.add(b); }
  scene.add(group); buildings.push(group); addCollision(x,z,1.2); return group;
}


const terraVisuals = {moss:[], grass:[], trees:[], water:null};
function makeTerraformVisuals(){
  for(let i=0;i<70;i++){
    const x=-150+Math.random()*300, z=-150+Math.random()*300; if(Math.hypot(x,z)<10) continue;
    const m=new THREE.Mesh(new THREE.CircleGeometry(.35+Math.random()*.7,8), new THREE.MeshBasicMaterial({color:0x2d8a43, transparent:true, opacity:.72}));
    m.rotation.x=-Math.PI/2; m.position.set(x, terrainHeight(x,z)+.035, z); m.visible=false; scene.add(m); terraVisuals.moss.push(m);
  }
  for(let i=0;i<90;i++){
    const x=-150+Math.random()*300, z=-150+Math.random()*300;
    const g=new THREE.Mesh(new THREE.ConeGeometry(.06,.65,5), mat(0x4cae50));
    g.position.set(x, terrainHeight(x,z)+.32, z); g.visible=false; scene.add(g); terraVisuals.grass.push(g);
  }
  for(let i=0;i<35;i++){
    const x=-145+Math.random()*290, z=-145+Math.random()*290;
    const tr=new THREE.Group(); const trunk=new THREE.Mesh(new THREE.CylinderGeometry(.05,.08,.9,6), mat(0x6b4630)); trunk.position.y=.45; tr.add(trunk); const leaf=new THREE.Mesh(new THREE.ConeGeometry(.42,1.0,7), mat(0x2f9f4f)); leaf.position.y=1.25; tr.add(leaf); tr.position.set(x, terrainHeight(x,z), z); tr.visible=false; scene.add(tr); terraVisuals.trees.push(tr);
  }
  terraVisuals.water=new THREE.Mesh(new THREE.CircleGeometry(32,48), new THREE.MeshStandardMaterial({color:0x2da6d8, transparent:true, opacity:.55, roughness:.28, metalness:.1}));
  terraVisuals.water.rotation.x=-Math.PI/2; terraVisuals.water.position.set(-18, terrainHeight(-18,-38)+.08, -38); terraVisuals.water.visible=false; scene.add(terraVisuals.water);
}
makeTerraformVisuals();
function terraformStage(){ const ti=Number(state.terraform_index||0); if(ti>=330) return 'Breathable Life'; if(ti>=250) return 'Trees'; if(ti>=190) return 'Flora'; if(ti>=140) return 'Moss'; if(ti>=95) return 'Lakes'; if(ti>=60) return 'Rain'; if(ti>=30) return 'Blue Sky'; return 'Dead Desert'; }
function updateTerraformVisuals(){
  const stage=terraformStage();
  const colors={ 'Dead Desert':0xb96532,'Blue Sky':0x7bbbe8,'Rain':0x5f7892,'Lakes':0x6fa8d8,'Moss':0x77a76b,'Flora':0x6fb970,'Trees':0x65b86e,'Breathable Life':0x79c47d };
  scene.background.setHex(colors[stage]||0xb96532); scene.fog.color.setHex(colors[stage]||0xb96532);
  terraVisuals.water.visible=['Lakes','Moss','Flora','Trees','Breathable Life'].includes(stage);
  terraVisuals.moss.forEach((o,i)=>o.visible=['Moss','Flora','Trees','Breathable Life'].includes(stage) && i < 16+(state.biomass||0));
  terraVisuals.grass.forEach((o,i)=>o.visible=['Flora','Trees','Breathable Life'].includes(stage) && i < 20+(state.biomass||0));
  terraVisuals.trees.forEach((o,i)=>o.visible=['Trees','Breathable Life'].includes(stage) && i < 5+Math.floor((state.biomass||0)/3));
}

function updateStats(){
  const el=document.getElementById('stats'); if(!el) return;
  el.innerHTML=`<b>🌍 ${state.name||'Veyra-1'}</b><br>Stage: ${terraformStage()}<br>Terraform Index: ${Math.round(state.terraform_index||0)}<br>Habitability: ${state.habitability||0}%<br>O₂: ${state.oxygen||0}% · Heat: ${state.heat||0}% · Pressure: ${state.pressure||0}%<br>Biomass: ${state.biomass||0}% · Water: ${state.water||0}%`; updateTerraformVisuals();
}
function updateSurvival(){
  const el=document.getElementById('survival'); if(!el) return;
  const row=(n,v)=>`<div class="${v<25?'low':''}">${n}: ${Math.max(0,Math.round(v))}%<div class="bar ${v<25?'danger':''}"><span style="width:${clamp(v,0,100)}%"></span></div></div>`;
  el.innerHTML=row('❤️ Health',survival.health)+row('🍖 Food',survival.food)+row('💧 Water',survival.water)+row('🫁 Oxygen',survival.oxygen)+(isBreathable()?'<b>Breathable Environment</b>':'<span class="low">Suit oxygen active</span>');
}
function normalizeInv(v,max=20){ return Array.isArray(v)?v.slice(0,max):[]; }
function updateInventory(){
  const grid=document.getElementById('inventoryGrid'); if(!grid) return; grid.innerHTML='';
  for(let i=0;i<20;i++){ const item=inventory[i]; const slot=document.createElement('div'); slot.className='inv-slot'; slot.innerHTML=itemSlotHtml(item); if(item && ['food_ration','water_bottle','oxygen_capsule'].includes(item)) slot.ondblclick=()=>useItem(item); grid.appendChild(slot); }
  const left=document.getElementById('playerContainerGrid'); if(left){ left.innerHTML=''; for(let i=0;i<20;i++){ const item=inventory[i]; const slot=document.createElement('div'); slot.className='inv-slot'; slot.innerHTML=itemSlotHtml(item); if(item) slot.onclick=()=>transferItem('to_container', i); left.appendChild(slot); } }
  const right=document.getElementById('containerGrid'); if(right){ right.innerHTML=''; for(let i=0;i<40;i++){ const item=activeContainerInventory[i]; const slot=document.createElement('div'); slot.className='inv-slot'; slot.innerHTML=itemSlotHtml(item); if(item) slot.onclick=()=>transferItem('to_player', i); right.appendChild(slot); } }
}
async function openContainer(key){
  activeContainerKey=key; containerOpen=true; document.exitPointerLock?.(); cancelMining('Mining cancelled.');
  try{ const r=await fetch(`/api/world/${WORLD_ID}/container/${key}`); const d=await r.json(); if(!r.ok) throw new Error(d.error); inventory=normalizeInv(d.player_inventory); activeContainerInventory=normalizeInv(d.container.inventory_json,40); document.getElementById('containerTitle').textContent=d.container.container_name||'Storage Container'; document.getElementById('containerOverlay').classList.remove('hidden'); updateInventory(); msg('Storage opened. Click items to move them between inventory and crate.'); }catch(e){ msg(e.message); }
}
function closeContainer(){ containerOpen=false; activeContainerKey=null; document.getElementById('containerOverlay').classList.add('hidden'); }
function openComputer(){ document.exitPointerLock?.(); cancelMining('Mining cancelled.'); document.getElementById('computerOverlay').classList.remove('hidden'); msg('Crash log opened. NOVA still has damaged memory fragments.'); }
function closeComputer(){ document.getElementById('computerOverlay').classList.add('hidden'); }
async function transferItem(direction,index){
  if(!activeContainerKey) return;
  try{ const r=await fetch(`/api/world/${WORLD_ID}/container/${activeContainerKey}/transfer`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({direction,index})}); const d=await r.json(); if(!r.ok) throw new Error(d.error); inventory=normalizeInv(d.player_inventory); activeContainerInventory=normalizeInv(d.container_inventory,40); updateInventory(); }catch(e){ msg(e.message); }
}
async function useItem(item){ try{ const r=await fetch(`/api/world/${WORLD_ID}/use_item`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({item})}); const d=await r.json(); if(!r.ok) throw new Error(d.error); inventory=normalizeInv(d.inventory); survival=d.survival; updateInventory(); updateSurvival(); msg(`${cap(item)} used.`); }catch(e){ msg(e.message); } }
async function loadState(){
  const r=await fetch(`/api/world/${WORLD_ID}/state`); const d=await r.json();
  state=d.planet||{}; updateStats(); const ps=d.player_state||{}; inventory=normalizeInv(ps.inventory_json); survival=Object.assign(survival, ps.survival_json||{}); player.position.set(survival.x||0, terrainHeight(survival.x||0,survival.z||5), survival.z||5); updateInventory(); updateSurvival(); (d.buildings||[]).forEach(b=>buildingMesh(b.building_type, Number(b.x), Number(b.z)));
  await loadNodes();
}
loadState();

function isBreathable(){ return (Math.abs(player.position.x)<2.25 && player.position.z<1.65 && player.position.z>-3.05) || state.oxygen >= 95; }
function updateToolHud(){ const el=document.getElementById('toolMode'); if(el) el.textContent=toolModes[toolIndex]; }
updateToolHud();

const oldCrateBtn=document.getElementById('crateBtn'); if(oldCrateBtn) oldCrateBtn.onclick=()=>openContainer('escape_pod_crate');
function openInventory(){ inventoryOpen=true; document.exitPointerLock?.(); document.getElementById('inventoryOverlay').classList.remove('hidden'); updateInventory(); cancelMining('Mining cancelled.'); }
function closeInventory(){ inventoryOpen=false; document.getElementById('inventoryOverlay').classList.add('hidden'); }
function openBuildMenu(){ buildOpen=true; document.exitPointerLock?.(); document.getElementById('buildMenu').classList.remove('hidden'); cancelMining('Mining cancelled.'); }
function closeBuildMenu(){ buildOpen=false; document.getElementById('buildMenu').classList.add('hidden'); }
document.getElementById('closeBuildMenu').onclick=closeBuildMenu;
async function placeBuild(type){ const fwd=new THREE.Vector3(-Math.sin(yaw),0,-Math.cos(yaw)); const x=player.position.x+fwd.x*5, z=player.position.z+fwd.z*5; try{ const r=await fetch(`/api/world/${WORLD_ID}/build`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({type,x,z})}); const d=await r.json(); if(!r.ok) throw new Error(d.error); inventory=normalizeInv(d.inventory); state=d.planet||state; updateInventory(); updateStats(); closeBuildMenu(); msg(`${cap(type)} built. Terraforming systems updated.`); }catch(e){ msg(e.message); } }
document.querySelectorAll('[data-build]').forEach(btn=>btn.onclick=()=>placeBuild(btn.dataset.build));
const closeComputerBtn=document.getElementById('closeComputer'); if(closeComputerBtn) closeComputerBtn.onclick=closeComputer;

function targetableMeshes(){ const arr=[]; for(const g of activeNodes.values()) arr.push(g); for(const c of containers.values()) arr.push(c); for(const i of interactables) arr.push(i); return arr; }
function getTargetFromChild(obj){ let o=obj, found=null; while(o){ if(o.userData?.nodeId) found=o; if(o.userData?.targetType) return o; o=o.parent; } if(found && found.userData?.nodeId){ const id=String(found.userData.nodeId); return activeNodes.get(id) || found; } return null; }
function getTarget(){ ray.setFromCamera(center,camera); const hits=ray.intersectObjects(targetableMeshes(), true); if(hits.length && hits[0].distance<32) return getTargetFromChild(hits[0].object); return null; }
function updateTargetHud(){
  const hud=document.getElementById('targetHud'), target=getTarget();
  if(target?.userData?.targetType==='container'){ hud.style.display='block'; hud.innerHTML=`⬡ ${target.userData.name}<br><small>Right click with multi-tool to open storage</small>`; }
  else if(target?.userData?.targetType==='computer'){ hud.style.display='block'; hud.innerHTML=`⬡ ${target.userData.name}<br><small>Right click to read the crash log</small>`; }
  else if(target && toolModes[toolIndex]==='Mining Mode'){ hud.style.display='block'; hud.innerHTML=`⬡ ${target.userData.name}<br><small>${ORE_RARITY[target.userData.resource]||'Common'} · Hold left click to mine</small>`; }
  else if(target && toolModes[toolIndex]==='Scanner Mode'){ hud.style.display='block'; hud.innerHTML=`⬡ ${target.userData.name}<br><small>${target.userData.region||'Ore Region'} · ${ORE_RARITY[target.userData.resource]||'Common'} Resource</small>`; }
  else hud.style.display='none';
}
function startMining(){
  if(toolModes[toolIndex]!=='Mining Mode') return; const target=getTarget(); if(!target || !target.userData.nodeId){ msg('No resource targeted. Look directly at a small embedded ore node.'); return; }
  if(inventory.length>=20){ msg('Inventory Full. Press TAB to manage your 20 slots.'); return; }
  const duration=(ORE_TIMES[target.userData.resource]||3)*1000;
  mining={target,start:performance.now(),duration,startX:player.position.x,startZ:player.position.z}; document.getElementById('mineProgress').style.display='block'; msg(`Mining ${target.userData.name}... hold still.`);
}
function cancelMining(text){ if(mining){ mining=null; miningBeam.visible=false; beamPulse.intensity=0; document.getElementById('mineProgress').style.display='none'; document.querySelector('#mineProgress div').style.width='0%'; if(text) msg(text); } }
async function finishMining(){
  const target=mining?.target; if(!target) return; mining=null; document.getElementById('mineProgress').style.display='none'; miningBeam.visible=false; beamPulse.intensity=0;
  try{ const r=await fetch(`/api/world/${WORLD_ID}/mine_node`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({node_id:target.userData.nodeId})}); const d=await r.json(); if(!r.ok) throw new Error(d.error); inventory=normalizeInv(d.inventory); updateInventory(); scene.remove(activeNodes.get(String(target.userData.nodeId)) || target); activeNodes.delete(String(target.userData.nodeId)); allNodeData = allNodeData.filter(n=>String(n.id)!==String(target.userData.nodeId)); msg(`${cap(d.resource)} collected. This node will regenerate somewhere random in about 2 hours.`); }catch(e){ msg(e.message); }
}
function miningTick(){
  if(!mining) return; const target=getTarget(); const moved=Math.hypot(player.position.x-mining.startX, player.position.z-mining.startZ)>.35;
  if(!target || String(target.userData.nodeId)!==String(mining.target.userData.nodeId) || moved || inventoryOpen || buildOpen || containerOpen){ cancelMining('Mining cancelled.'); return; }
  const pct=Math.min(1,(performance.now()-mining.start)/mining.duration); document.querySelector('#mineProgress div').style.width=`${pct*100}%`; if(pct>=1) finishMining();
}

function blockedPosition(x,z){
  for(const c of collisionCircles){ if(Math.hypot(x-c.x,z-c.z)<c.r) return true; }
  return false;
}
function tryMove(dx,dz){
  const nx=player.position.x+dx, nz=player.position.z+dz;
  if(Math.abs(nx)>166||Math.abs(nz)>166) return;
  if(blockedPosition(nx,nz)) return;
  const slope=terrainSlope(nx,nz); if(slope>0.95) return; // too steep to climb
  player.position.x=nx; player.position.z=nz;
}

renderer.domElement.addEventListener('mousedown', ev=>{ if(inventoryOpen||buildOpen||containerOpen) return; const target=getTarget(); if(ev.button===2 && target?.userData?.targetType==='container'){ openContainer(target.userData.containerKey); return; } if(ev.button===2 && target?.userData?.targetType==='computer'){ openComputer(); return; } if(document.pointerLockElement!==renderer.domElement) renderer.domElement.requestPointerLock(); if(toolModes[toolIndex]==='Building Mode'&&(ev.button===0||ev.button===2)){ openBuildMenu(); return; } if(ev.button===0) startMining(); });
renderer.domElement.addEventListener('mouseup', ev=>{ /* mining now continues after click; moving/looking away still cancels */ });
renderer.domElement.addEventListener('contextmenu', ev=>ev.preventDefault());
addEventListener('mousemove', e=>{ if(document.pointerLockElement===renderer.domElement&&!inventoryOpen&&!buildOpen&&!containerOpen){ yaw-=e.movementX*.0022; pitch-=e.movementY*.0022; pitch=clamp(pitch,-1.2,1.2); }});
addEventListener('keydown', e=>{ const k=e.key.toLowerCase(); keys[k]=true; if(k==='tab'){ e.preventDefault(); inventoryOpen?closeInventory():openInventory(); } if(k==='escape'){ closeInventory(); closeBuildMenu(); closeContainer(); closeComputer(); } if(k==='r'&&!inventoryOpen&&!buildOpen&&!containerOpen){ toolIndex=(toolIndex+1)%toolModes.length; updateToolHud(); msg(`Multi-tool switched to ${toolModes[toolIndex]}.`); cancelMining(); } if(k==='v'&&!inventoryOpen&&!buildOpen&&!containerOpen){ firstPerson=!firstPerson; document.getElementById('cameraMode').textContent=firstPerson?'First Person':'Third Person'; msg(firstPerson?'First person enabled.':'Third person enabled.'); }});
addEventListener('keyup', e=>{ keys[e.key.toLowerCase()]=false; });
addEventListener('resize',()=>{ camera.aspect=innerWidth/innerHeight; camera.updateProjectionMatrix(); renderer.setSize(innerWidth,innerHeight); });

socket.emit('join',{world_id:WORLD_ID});
socket.on('current_players', ps=>{ for(const sid in ps){ if(sid!==socket.id) createOther(sid,ps[sid]); }});
socket.on('player_joined', p=>{ createOther(p.sid,p); addChat({username:'NOVA',message:`${p.username} joined this world.`,time:''}); });
socket.on('player_moved', p=>{ if(others[p.sid]){ const o=others[p.sid]; const old=o.position.clone(); o.position.set(p.x, terrainHeight(p.x,p.z), p.z); o.rotation.y=p.rot; poseAstronaut(o, old.distanceTo(o.position)>.02, p.running, .05); }});
socket.on('player_left', p=>{ if(others[p.sid]){ scene.remove(others[p.sid]); delete others[p.sid]; } addChat({username:'NOVA',message:`${p.username} left the world.`,time:''}); });
socket.on('node_mined', d=>{ allNodeData = allNodeData.filter(n=>String(n.id)!==String(d.id)); const n=activeNodes.get(String(d.id)); if(n){ scene.remove(n); activeNodes.delete(String(d.id)); }});
socket.on('building_added', b=>buildingMesh(b.building_type, Number(b.x), Number(b.z)));
socket.on('planet_update', s=>{ state=s; updateStats(); });
socket.on('chat_history', h=>h.forEach(addChat)); socket.on('chat', addChat); socket.on('player_died', p=>addChat({username:'NOVA',message:`${p.username} respawned at the escape pod.`,time:''}));
function createOther(sid,p){ if(others[sid]) return; const o=astronaut(0xffcc66,p.username); o.position.set(p.x||0, terrainHeight(p.x||0,p.z||5), p.z||5); scene.add(o); others[sid]=o; }
function escapeHtml(s){ return String(s).replace(/[&<>"']/g,m=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m])); }
function addChat(c){ const box=document.getElementById('chatMessages'); const div=document.createElement('div'); div.className='chat-line'; div.innerHTML=`<b>${escapeHtml(c.username)}</b>: ${escapeHtml(c.message)}`; box.appendChild(div); box.scrollTop=box.scrollHeight; }
document.getElementById('chatInput').addEventListener('keydown', e=>{ if(e.key==='Enter'){ socket.emit('chat',{message:e.target.value}); e.target.value=''; }});

async function saveSurvival(){ survival.x=player.position.x; survival.z=player.position.z; try{ const r=await fetch(`/api/world/${WORLD_ID}/survival`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(survival)}); const d=await r.json(); if(d.ok){ survival=d.survival; inventory=normalizeInv(d.inventory); if(d.died){ player.position.set(0, terrainHeight(0,5), 5); msg('You died and respawned in the escape pod. Your inventory dropped at your death location.'); } updateSurvival(); updateInventory(); }}catch(e){} }
function survivalTick(dt){ survival.food-=dt*.10; survival.water-=dt*.16; if(!isBreathable()) survival.oxygen-=dt*.42; else survival.oxygen=Math.min(100,survival.oxygen+dt*3.2); if(survival.food<=0||survival.water<=0||survival.oxygen<=0) survival.health-=dt*4.5; else survival.health=Math.min(100,survival.health+dt*.22); updateSurvival(); }

function updateAutomaticDoors(dt){
  // Escape pod automatic hatch. It opens when close and closes when the player walks away.
  if(podDoorMesh){
    const dist=Math.hypot(player.position.x-0, player.position.z-(-2.8));
    podDoorTargetOpen = dist < 4.2;
    const targetY = podDoorTargetOpen ? podDoorMesh.userData.openY : podDoorMesh.userData.closedY;
    const targetZ = podDoorTargetOpen ? podDoorMesh.userData.openZ : podDoorMesh.userData.closedZ;
    podDoorMesh.position.y += (targetY-podDoorMesh.position.y)*Math.min(1,dt*6);
    podDoorMesh.position.z += (targetZ-podDoorMesh.position.z)*Math.min(1,dt*6);
    podDoorMesh.rotation.x = podDoorTargetOpen ? -0.18 : 0;
    if(podInteriorLight) podInteriorLight.intensity = isBreathable()?1.8:1.05;
  }
  for(const d of stationDoorMeshes){
    const dist=Math.hypot(player.position.x-d.userData.worldX, player.position.z-d.userData.worldZ);
    const targetY=dist<5.2 ? d.userData.openY : d.userData.baseY;
    d.position.y += (targetY-d.position.y)*Math.min(1,dt*4.5);
  }
}

function animate(t){
  requestAnimationFrame(animate); const dt=Math.min(.08, clock.getDelta()); survivalTick(dt); updateVisibleNodes(false); updateAutomaticDoors(dt); miningTick(); updateTargetHud(); updateGun(!!mining,dt,mining?.target);
  const running=!!keys['shift']; const moveSpeed=(running ? 15.5 : 9.0); const fwd=new THREE.Vector3(-Math.sin(yaw),0,-Math.cos(yaw)); const right=new THREE.Vector3(Math.cos(yaw),0,-Math.sin(yaw)); let mv=new THREE.Vector3();
  if(!inventoryOpen&&!buildOpen&&!containerOpen){ if(keys['w']) mv.add(fwd); if(keys['s']) mv.sub(fwd); if(keys['a']) mv.sub(right); if(keys['d']) mv.add(right); }
  if(mv.length()>0){ mv.normalize().multiplyScalar(moveSpeed*dt); tryMove(mv.x,mv.z); }
  const groundY=terrainHeight(player.position.x,player.position.z); if(keys[' ']&&grounded&&!inventoryOpen&&!buildOpen&&!containerOpen){ velocityY=7.8; grounded=false; } velocityY-=24*dt; player.position.y+=velocityY*dt; if(player.position.y<=groundY){ player.position.y=groundY; velocityY=0; grounded=true; }
  const moving=mv.length()>0; if(moving) player.rotation.y=yaw+Math.PI; poseAstronaut(player,moving,running,dt);
  if(firstPerson){ player.visible=false; firstPersonTool.visible=true; camera.position.set(player.position.x,player.position.y+2.05,player.position.z); camera.rotation.order='YXZ'; camera.rotation.y=yaw; camera.rotation.x=pitch; }
  else{ player.visible=true; firstPersonTool.visible=false; const camPos=new THREE.Vector3(player.position.x+Math.sin(yaw)*8,player.position.y+5,player.position.z+Math.cos(yaw)*8); camera.position.lerp(camPos,.12); camera.lookAt(player.position.x,player.position.y+1.5,player.position.z); }
  if(t-lastEmit>65){ socket.emit('move',{x:player.position.x,z:player.position.z,rot:player.rotation.y,camera:firstPerson?'first':'third',running}); lastEmit=t; }
  if(t-lastSave>5000){ saveSurvival(); lastSave=t; }
  renderer.render(scene,camera);
}
animate(0);
