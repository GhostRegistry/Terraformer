import os, json, random, string
from datetime import datetime, timezone
from functools import wraps
from dotenv import load_dotenv
from flask import Flask, render_template, request, redirect, session, jsonify, flash
from flask_socketio import SocketIO, emit, join_room, leave_room
from supabase import create_client, Client
from werkzeug.security import generate_password_hash, check_password_hash

load_dotenv()
SUPABASE_URL = os.getenv('SUPABASE_URL', '').strip()
SUPABASE_KEY = os.getenv('SUPABASE_KEY', os.getenv('SUPABASE_ANON_KEY', '')).strip()
SECRET_KEY = os.getenv('SECRET_KEY', 'terraformer-local-secret')

app = Flask(__name__)
app.secret_key = SECRET_KEY
socketio = SocketIO(app, cors_allowed_origins='*', async_mode='threading')
supabase: Client | None = create_client(SUPABASE_URL, SUPABASE_KEY) if SUPABASE_URL and SUPABASE_KEY else None

online_players = {}  # sid -> {user_id, username, role, world_id, x,z,rot}
chat_history = {}    # world_id -> list

START_PLANET = {
    'name':'Veyra-1','oxygen':0,'heat':0,'pressure':0,'biomass':0,'water':0,'temperature':-40,'biodiversity':0,'atmosphere':0,
    'habitability':0,'terraform_index':0,'energy':20,'research':0
}
START_SURVIVAL = {'health':100,'food':100,'water':100,'oxygen':100,'x':0,'z':5}
START_INV = []
CRATE_ITEMS = ['food_ration']*10 + ['water_bottle']*8 + ['oxygen_capsule']*6 + ['battery_cell']*3 + ['iron','titanium','silicon','cobalt']
MAX_INV_SLOTS = 20

ORE_RESPAWN_SECONDS = 2 * 60 * 60
# Planet-crafter-inspired resource set from the design list. These are the resources that spawn, show icons, and appear in inventory.
ORE_TYPES = ['iron','titanium','silicon','magnesium','cobalt','ice','aluminum','iridium','uranium','sulfur','osmium','super_alloy','zeolite','pulsar_quartz']
MINING_TIMES = {'iron':3,'titanium':4,'silicon':3,'magnesium':3,'cobalt':3,'ice':2,'aluminum':5,'iridium':6,'uranium':6,'sulfur':5,'osmium':7,'super_alloy':7,'zeolite':8,'pulsar_quartz':10}
# More total nodes, but the browser only renders nearby nodes for performance.
NODE_TARGET_COUNT = 420
ORE_REGIONS = {
    'Starter Desert': {'center':(18, 20), 'radius':38, 'bonus':['iron','titanium','silicon','magnesium','cobalt','ice']},
    'Pod Ridge': {'center':(-30, 28), 'radius':34, 'bonus':['iron','titanium','silicon','ice']},
    'Aluminum Fields': {'center':(-92, 36), 'radius':45, 'bonus':['aluminum','iron','silicon']},
    'Iridium Cave Rim': {'center':(92, 45), 'radius':48, 'bonus':['iridium','titanium','magnesium']},
    'Sulfur Fields': {'center':(-72, -92), 'radius':44, 'bonus':['sulfur','silicon','magnesium']},
    'Uranium Caves': {'center':(106, -92), 'radius':40, 'bonus':['uranium','osmium','cobalt']},
    'Osmium Ice Basin': {'center':(18, 108), 'radius':46, 'bonus':['osmium','ice','super_alloy']},
    'Super Alloy Cliffs': {'center':(-126, -30), 'radius':38, 'bonus':['super_alloy','aluminum','titanium']},
    'Late Terraform Ridge': {'center':(135, 5), 'radius':32, 'bonus':['zeolite','pulsar_quartz','osmium']},
}
COMMON_ORES = ['iron','titanium','silicon','magnesium','cobalt','ice']

def random_node_position(region=None):
    # Same handcrafted world every save, but ore locations are random inside named regions.
    info = ORE_REGIONS.get(region) if region else random.choice(list(ORE_REGIONS.values()))
    cx, cz = info['center']; radius = info['radius']
    for _ in range(80):
        ang=random.random()*6.283185; dist=(random.random()**0.5)*radius
        x = cx + random.cos(ang)*dist if False else cx + __import__('math').cos(ang)*dist
        z = cz + __import__('math').sin(ang)*dist
        if (x*x + z*z) < 260: continue
        if -42 < x < 45 and -70 < z < -22: continue
        return round(x, 2), round(z, 2)
    return round(cx, 2), round(cz, 2)

def random_resource(region=None):
    info = ORE_REGIONS.get(region) if region else random.choice(list(ORE_REGIONS.values()))
    # Every region can spawn iron, titanium and silicon; each region also has special ores.
    pool = COMMON_ORES * 10 + info['bonus'] * 7
    if random.random() < 0.10:
        pool += ['aluminum','iridium','uranium','sulfur','osmium','super_alloy','zeolite','pulsar_quartz']
    return random.choice(pool)

def random_region_name():
    return random.choice(list(ORE_REGIONS.keys()))

def ensure_resource_nodes(world_id):
    """Creates and slowly regenerates many small embedded ore nodes for a world."""
    # Clear any old prototype resources from earlier betas.
    try:
        sb('resource_nodes').delete().eq('world_id', world_id).not_.in_('resource_type', ORE_TYPES).execute()
    except Exception:
        pass

    existing = sb('resource_nodes').select('id').eq('world_id', world_id).execute().data or []
    # Performance pass: old test worlds may have far too many nodes. Trim extras so the browser stays smooth.
    if len(existing) > NODE_TARGET_COUNT:
        extra_ids = [r['id'] for r in existing[NODE_TARGET_COUNT:]]
        for i in range(0, len(extra_ids), 100):
            sb('resource_nodes').delete().in_('id', extra_ids[i:i+100]).execute()
        existing = existing[:NODE_TARGET_COUNT]
    if len(existing) < NODE_TARGET_COUNT:
        rows=[]
        for _ in range(NODE_TARGET_COUNT - len(existing)):
            region=random_region_name()
            x,z=random_node_position(region)
            res=random_resource(region)
            rows.append({'world_id':world_id,'resource_type':res,'region_name':region,'x':x,'z':z,'active':True,'respawn_at':None,'created_at':now_iso(),'updated_at':now_iso()})
        if rows:
            sb('resource_nodes').insert(rows).execute()

    now = datetime.now(timezone.utc)
    inactive = sb('resource_nodes').select('*').eq('world_id', world_id).eq('active', False).execute().data
    for n in inactive:
        resp = n.get('respawn_at')
        if not resp:
            continue
        try:
            resp_dt = datetime.fromisoformat(str(resp).replace('Z', '+00:00'))
        except Exception:
            continue
        if resp_dt <= now:
            region=n.get('region_name') or random_region_name()
            x,z=random_node_position(region)
            sb('resource_nodes').update({'x':x,'z':z,'resource_type':random_resource(region),'region_name':region,'active':True,'respawn_at':None,'updated_at':now_iso()}).eq('id', n['id']).execute()


def now_iso(): return datetime.now(timezone.utc).isoformat()
def sb(table): return supabase.table(table)
def require_supabase(): return supabase is not None

def setup_start_data():
    if not require_supabase(): return
    try:
        if not sb('users').select('id').eq('username','owner').execute().data:
            sb('users').insert({'username':'owner','password_hash':generate_password_hash('owner123'),'role':'owner','is_disabled':False,'created_at':now_iso()}).execute()
    except Exception as exc:
        print('Startup setup failed. Run supabase_setup.sql:', exc)

def current_user():
    if 'user_id' not in session or not require_supabase(): return None
    try:
        rows = sb('users').select('id, username, role, is_disabled').eq('id', session['user_id']).execute().data
        if not rows or rows[0].get('is_disabled'):
            session.clear(); return None
        return rows[0]
    except Exception:
        session.clear(); return None

def login_required(fn):
    @wraps(fn)
    def wrapper(*args, **kwargs):
        if not current_user(): return redirect('/')
        return fn(*args, **kwargs)
    return wrapper

def role_required(*roles):
    def deco(fn):
        @wraps(fn)
        def wrapper(*args, **kwargs):
            u=current_user()
            if not u or u['role'] not in roles: return redirect('/menu')
            return fn(*args, **kwargs)
        return wrapper
    return deco

def code(): return '-'.join([''.join(random.choice(string.ascii_uppercase+string.digits) for _ in range(4)) for _ in range(2)])

def get_member(world_id, user_id):
    rows = sb('world_members').select('*').eq('world_id', world_id).eq('user_id', user_id).execute().data
    return rows[0] if rows else None

def get_world(world_id):
    rows = sb('worlds').select('*').eq('id', world_id).execute().data
    return rows[0] if rows else None

def can_access_world(world_id, user):
    w = get_world(world_id)
    if not w: return False
    if w['owner_id'] == user['id']: return True
    return get_member(world_id, user['id']) is not None

def default_player_state(world_id, user_id):
    rows = sb('player_states').select('*').eq('world_id', world_id).eq('user_id', user_id).execute().data
    if rows: return rows[0]
    inserted = sb('player_states').insert({
        'world_id':world_id, 'user_id':user_id, 'survival_json':START_SURVIVAL,
        'inventory_json':START_INV, 'has_opened_crate':False, 'updated_at':now_iso()
    }).execute().data
    return inserted[0]


def ensure_start_container(world_id):
    existing = sb('world_containers').select('id').eq('world_id', world_id).eq('container_key','escape_pod_crate').execute().data
    if existing:
        return existing[0]
    row = sb('world_containers').insert({
        'world_id': world_id,
        'container_key': 'escape_pod_crate',
        'container_name': 'Emergency Supply Crate',
        'x': 3.25,
        'z': 1.6,
        'inventory_json': CRATE_ITEMS,
        'created_at': now_iso(),
        'updated_at': now_iso()
    }).execute().data[0]
    return row

def create_world(owner, name='Crash World', is_hosted=False):
    join_code = code() if is_hosted else None
    w = sb('worlds').insert({
        'name': name or 'Crash World', 'owner_id': owner['id'], 'owner_username': owner['username'],
        'is_hosted': is_hosted, 'join_code': join_code, 'created_at': now_iso(), 'updated_at': now_iso()
    }).execute().data[0]
    sb('world_members').insert({'world_id':w['id'],'user_id':owner['id'],'username':owner['username'],'member_role':'owner','joined_at':now_iso()}).execute()
    sb('world_states').insert({'world_id':w['id'],'state_json':START_PLANET,'updated_at':now_iso()}).execute()
    default_player_state(w['id'], owner['id'])
    ensure_resource_nodes(w['id'])
    ensure_start_container(w['id'])
    return w

def state_for_world(world_id):
    rows = sb('world_states').select('state_json').eq('world_id', world_id).execute().data
    return rows[0]['state_json'] if rows else START_PLANET.copy()

def save_world_state(world_id, state):
    sb('world_states').update({'state_json':state,'updated_at':now_iso()}).eq('world_id', world_id).execute()
    sb('worlds').update({'updated_at':now_iso()}).eq('id', world_id).execute()

def calc_habitability(s):
    temp_score = max(0, min(100, 100 - abs(18 - s.get('temperature',-40))*2))
    return int((s.get('oxygen',0)+s.get('heat',0)+s.get('pressure',0)+s.get('biomass',0)+s.get('water',0)+temp_score)/6)


def normalize_inventory(inv):
    # Convert old count-based inventories into the new 20-slot, no-stacking list.
    if isinstance(inv, list):
        return [str(x) for x in inv if x][:MAX_INV_SLOTS]
    slots = []
    if isinstance(inv, dict):
        for item, count in inv.items():
            try:
                count = int(count)
            except Exception:
                count = 0
            for _ in range(max(0, count)):
                if len(slots) < MAX_INV_SLOTS:
                    slots.append(str(item))
    return slots[:MAX_INV_SLOTS]

def add_items(inv, items):
    inv = normalize_inventory(inv)
    added = 0
    for item in items:
        if len(inv) >= MAX_INV_SLOTS:
            break
        inv.append(str(item)); added += 1
    return added, inv

def remove_one(inv, item):
    inv = normalize_inventory(inv)
    try:
        inv.remove(item)
        return True, inv
    except ValueError:
        return False, inv

def has_cost(inv, cost):
    inv = normalize_inventory(inv)
    for item, amount in cost.items():
        if inv.count(item) < amount:
            return False
    return True

def pay_cost(inv, cost):
    inv = normalize_inventory(inv)
    for item, amount in cost.items():
        for _ in range(amount):
            inv.remove(item)
    return inv

@app.before_request
def no_supabase():
    if request.path.startswith('/static') or request.path == '/setup-warning': return None
    if not require_supabase(): return redirect('/setup-warning')

@app.route('/setup-warning')
def setup_warning():
    return 'Supabase is not configured. Add SUPABASE_URL, SUPABASE_KEY, and SECRET_KEY to .env or Render environment variables.', 500

@app.route('/', methods=['GET','POST'])
def login():
    if current_user(): return redirect('/menu')
    error=None
    if request.method == 'POST':
        username=request.form.get('username','').strip(); password=request.form.get('password','')
        try:
            rows=sb('users').select('*').eq('username',username).execute().data
            u=rows[0] if rows else None
            if u and not u.get('is_disabled') and check_password_hash(u['password_hash'], password):
                session['user_id']=u['id']; session['username']=u['username']; session['role']=u['role']; return redirect('/menu')
        except Exception as exc: error=f'Database error: {exc}'
        error = error or 'Invalid login or disabled account.'
    return render_template('login.html', error=error)

@app.route('/logout')
def logout(): session.clear(); return redirect('/')

@app.route('/menu')
@login_required
def menu():
    u=current_user()
    owned=sb('worlds').select('*').eq('owner_id',u['id']).order('updated_at', desc=True).execute().data
    memberships=sb('world_members').select('world_id').eq('user_id',u['id']).execute().data
    ids=[m['world_id'] for m in memberships]
    joined=[]
    if ids:
        joined=sb('worlds').select('*').in_('id', ids).neq('owner_id',u['id']).order('updated_at', desc=True).execute().data
    return render_template('menu.html', user=u, owned=owned, joined=joined)

@app.route('/world/create', methods=['POST'])
@login_required
def world_create():
    u=current_user(); name=request.form.get('name','Crash World').strip(); w=create_world(u, name, False)
    return redirect(f'/game/{w["id"]}')

@app.route('/world/<int:world_id>/host', methods=['POST'])
@login_required
def world_host(world_id):
    u=current_user(); w=get_world(world_id)
    if not w or w['owner_id'] != u['id']: return redirect('/menu')
    join_code=w.get('join_code') or code()
    sb('worlds').update({'is_hosted':True,'join_code':join_code,'updated_at':now_iso()}).eq('id',world_id).execute()
    flash(f'World hosted. Join code: {join_code}')
    return redirect('/menu')

@app.route('/world/<int:world_id>/unhost', methods=['POST'])
@login_required
def world_unhost(world_id):
    u=current_user(); w=get_world(world_id)
    if w and w['owner_id']==u['id']:
        sb('worlds').update({'is_hosted':False,'join_code':None,'updated_at':now_iso()}).eq('id',world_id).execute()
        flash('World is private again.')
    return redirect('/menu')

@app.route('/world/join', methods=['POST'])
@login_required
def world_join():
    u=current_user(); jc=request.form.get('join_code','').strip().upper()
    rows=sb('worlds').select('*').eq('join_code',jc).eq('is_hosted',True).execute().data
    if not rows:
        flash('No hosted world found with that code.'); return redirect('/menu')
    w=rows[0]
    if not get_member(w['id'], u['id']):
        sb('world_members').insert({'world_id':w['id'],'user_id':u['id'],'username':u['username'],'member_role':'member','joined_at':now_iso()}).execute()
    default_player_state(w['id'], u['id'])
    return redirect(f'/game/{w["id"]}')

@app.route('/game/<int:world_id>')
@login_required
def game(world_id):
    u=current_user()
    if not can_access_world(world_id, u): return redirect('/menu')
    w=get_world(world_id); default_player_state(world_id, u['id'])
    return render_template('game.html', user=u, world=w)

@app.route('/game')
@login_required
def old_game_redirect(): return redirect('/menu')

@app.route('/admin', methods=['GET','POST'])
@login_required
@role_required('owner','admin')
def admin_panel():
    u=current_user()
    if request.method=='POST':
        action=request.form.get('action')
        try:
            if action=='create_user':
                username=request.form.get('username','').strip(); password=request.form.get('password','').strip(); role=request.form.get('role','player')
                if u['role']=='admin' and role!='player': flash('Admins can only create player accounts.')
                elif username and password and role in ['player','admin','owner']:
                    if sb('users').select('id').eq('username',username).execute().data: flash('That username already exists.')
                    else:
                        sb('users').insert({'username':username,'password_hash':generate_password_hash(password),'role':role,'is_disabled':False,'created_at':now_iso()}).execute(); flash('Account created.')
            elif action=='reset_password':
                target_id=int(request.form.get('target_id')); new_password=request.form.get('new_password','').strip()
                target=sb('users').select('*').eq('id',target_id).execute().data[0]
                if u['role']=='admin' and target['role']!='player': flash('Admins can only reset player passwords.')
                elif new_password:
                    sb('users').update({'password_hash':generate_password_hash(new_password)}).eq('id',target_id).execute(); flash('Password reset.')
            elif action=='toggle_disable':
                target_id=int(request.form.get('target_id')); target=sb('users').select('*').eq('id',target_id).execute().data[0]
                if target['id']==u['id']: flash('You cannot disable yourself.')
                elif u['role']=='admin' and target['role']!='player': flash('Admins can only disable player accounts.')
                else: sb('users').update({'is_disabled':not bool(target['is_disabled'])}).eq('id',target_id).execute(); flash('Account status changed.')
        except Exception as exc: flash(f'Database error: {exc}')
    users=sb('users').select('id, username, role, is_disabled, created_at').order('username').execute().data
    worlds=sb('worlds').select('*').order('updated_at', desc=True).limit(50).execute().data
    return render_template('admin.html', user=u, users=users, worlds=worlds)

@app.route('/api/world/<int:world_id>/state')
@login_required
def api_state(world_id):
    u=current_user()
    if not can_access_world(world_id,u): return jsonify({'error':'No access'}),403
    ensure_resource_nodes(world_id)
    ensure_start_container(world_id)
    buildings=sb('world_buildings').select('*').eq('world_id', world_id).execute().data
    containers=sb('world_containers').select('*').eq('world_id', world_id).execute().data
    ps=default_player_state(world_id, u['id'])
    return jsonify({'planet':state_for_world(world_id),'buildings':buildings,'containers':containers,'player_state':ps,'ore_types':ORE_TYPES,'mining_times':MINING_TIMES})


@app.route('/api/world/<int:world_id>/nodes')
@login_required
def api_nodes(world_id):
    u=current_user()
    if not can_access_world(world_id,u): return jsonify({'error':'No access'}),403
    ensure_resource_nodes(world_id)
    nodes=sb('resource_nodes').select('id, resource_type, region_name, x, z, active, respawn_at').eq('world_id', world_id).eq('active', True).limit(420).execute().data
    return jsonify({'ok':True,'nodes':nodes,'respawn_seconds':ORE_RESPAWN_SECONDS})

@app.route('/api/world/<int:world_id>/mine_node', methods=['POST'])
@login_required
def api_mine_node(world_id):
    u=current_user()
    if not can_access_world(world_id,u): return jsonify({'error':'No access'}),403
    data=request.get_json(force=True)
    node_id=int(data.get('node_id',0))
    rows=sb('resource_nodes').select('*').eq('world_id', world_id).eq('id', node_id).eq('active', True).execute().data
    if not rows: return jsonify({'ok':False,'error':'That ore node is no longer available.'}),404
    node=rows[0]
    res=node.get('resource_type','iron')
    ps=default_player_state(world_id,u['id'])
    inv=normalize_inventory(ps.get('inventory_json') or [])
    added, inv = add_items(inv, [res])
    if added <= 0:
        return jsonify({'ok':False,'error':'Inventory Full','inventory':inv}),400
    respawn_at = datetime.fromtimestamp(datetime.now(timezone.utc).timestamp() + ORE_RESPAWN_SECONDS, timezone.utc).isoformat()
    sb('resource_nodes').update({'active':False,'respawn_at':respawn_at,'updated_at':now_iso()}).eq('id', node_id).execute()
    sb('player_states').update({'inventory_json':inv,'updated_at':now_iso()}).eq('id',ps['id']).execute()
    socketio.emit('node_mined', {'id':node_id,'resource_type':res,'respawn_at':respawn_at}, room=f'world-{world_id}')
    return jsonify({'ok':True,'inventory':inv,'resource':res,'respawn_at':respawn_at})

@app.route('/api/world/<int:world_id>/collect', methods=['POST'])
@login_required
def api_collect(world_id):
    u=current_user()
    if not can_access_world(world_id,u): return jsonify({'error':'No access'}),403
    data=request.get_json(force=True); res=str(data.get('resource','iron')); amount=max(1,min(5,int(data.get('amount',1))))
    ps=default_player_state(world_id,u['id']); inv=normalize_inventory(ps.get('inventory_json') or [])
    added, inv = add_items(inv, [res] * amount)
    sb('player_states').update({'inventory_json':inv,'updated_at':now_iso()}).eq('id',ps['id']).execute()
    if added <= 0:
        return jsonify({'ok':False,'error':'Inventory Full','inventory':inv}),400
    return jsonify({'ok':True,'inventory':inv,'added':added})

@app.route('/api/world/<int:world_id>/container/<container_key>')
@login_required
def api_container(world_id, container_key):
    u=current_user()
    if not can_access_world(world_id,u): return jsonify({'error':'No access'}),403
    ensure_start_container(world_id)
    rows=sb('world_containers').select('*').eq('world_id',world_id).eq('container_key',container_key).execute().data
    if not rows: return jsonify({'ok':False,'error':'Container not found'}),404
    ps=default_player_state(world_id,u['id'])
    return jsonify({'ok':True,'container':rows[0],'player_inventory':normalize_inventory(ps.get('inventory_json') or [])})

@app.route('/api/world/<int:world_id>/container/<container_key>/transfer', methods=['POST'])
@login_required
def api_container_transfer(world_id, container_key):
    u=current_user(); data=request.get_json(force=True)
    if not can_access_world(world_id,u): return jsonify({'error':'No access'}),403
    ensure_start_container(world_id)
    rows=sb('world_containers').select('*').eq('world_id',world_id).eq('container_key',container_key).execute().data
    if not rows: return jsonify({'ok':False,'error':'Container not found'}),404
    container=rows[0]; c_inv=normalize_inventory(container.get('inventory_json') or [])
    ps=default_player_state(world_id,u['id']); p_inv=normalize_inventory(ps.get('inventory_json') or [])
    direction=data.get('direction')
    index=int(data.get('index',-1))
    if direction=='to_container':
        if index<0 or index>=len(p_inv): return jsonify({'ok':False,'error':'Invalid player slot'}),400
        if len(c_inv)>=40: return jsonify({'ok':False,'error':'Container full'}),400
        c_inv.append(p_inv.pop(index))
    elif direction=='to_player':
        if index<0 or index>=len(c_inv): return jsonify({'ok':False,'error':'Invalid container slot'}),400
        if len(p_inv)>=MAX_INV_SLOTS: return jsonify({'ok':False,'error':'Inventory full'}),400
        p_inv.append(c_inv.pop(index))
    else:
        return jsonify({'ok':False,'error':'Invalid transfer direction'}),400
    sb('player_states').update({'inventory_json':p_inv,'updated_at':now_iso()}).eq('id',ps['id']).execute()
    sb('world_containers').update({'inventory_json':c_inv,'updated_at':now_iso()}).eq('id',container['id']).execute()
    return jsonify({'ok':True,'player_inventory':p_inv,'container_inventory':c_inv})

@app.route('/api/world/<int:world_id>/use_item', methods=['POST'])
@login_required
def api_use_item(world_id):
    u=current_user(); data=request.get_json(force=True); item=data.get('item')
    if not can_access_world(world_id,u): return jsonify({'error':'No access'}),403
    ps=default_player_state(world_id,u['id']); inv=normalize_inventory(ps.get('inventory_json') or []); surv=ps.get('survival_json') or START_SURVIVAL.copy()
    ok, inv = remove_one(inv, item)
    if not ok: return jsonify({'ok':False,'error':'You do not have that item.','inventory':inv,'survival':surv}),400
    if item=='food_ration': surv['food']=min(100, surv.get('food',100)+35)
    elif item=='water_bottle': surv['water']=min(100, surv.get('water',100)+40)
    elif item=='oxygen_capsule': surv['oxygen']=min(100, surv.get('oxygen',100)+55)
    else: inv.append(item); return jsonify({'ok':False,'error':'Cannot use that item.'}),400
    sb('player_states').update({'inventory_json':inv,'survival_json':surv,'updated_at':now_iso()}).eq('id',ps['id']).execute()
    return jsonify({'ok':True,'inventory':inv,'survival':surv})

@app.route('/api/world/<int:world_id>/survival', methods=['POST'])
@login_required
def api_survival(world_id):
    u=current_user(); data=request.get_json(force=True)
    if not can_access_world(world_id,u): return jsonify({'error':'No access'}),403
    ps=default_player_state(world_id,u['id']); surv=ps.get('survival_json') or START_SURVIVAL.copy(); inv=normalize_inventory(ps.get('inventory_json') or [])
    for k in ['health','food','water','oxygen','x','z']:
        if k in data: surv[k]=data[k]
    died=surv.get('health',100)<=0 or surv.get('food',0)<=0 or surv.get('water',0)<=0 or surv.get('oxygen',0)<=0
    dropped=None
    if died:
        dropped={'world_id':world_id,'user_id':u['id'],'username':u['username'],'x':surv.get('x',0),'z':surv.get('z',0),'inventory_json':inv,'created_at':now_iso()}
        if inv: sb('dropped_inventories').insert(dropped).execute()
        inv=START_INV.copy(); surv=START_SURVIVAL.copy()
    sb('player_states').update({'survival_json':surv,'inventory_json':inv,'updated_at':now_iso()}).eq('id',ps['id']).execute()
    if died: socketio.emit('player_died', {'username':u['username']}, room=f'world-{world_id}')
    return jsonify({'ok':True,'died':died,'survival':surv,'inventory':inv})

@app.route('/api/world/<int:world_id>/build', methods=['POST'])
@login_required
def api_build(world_id):
    u=current_user(); data=request.get_json(force=True)
    if not can_access_world(world_id,u): return jsonify({'error':'No access'}),403
    btype=data.get('type','solar'); x=float(data.get('x',0)); z=float(data.get('z',0))
    costs={'solar':{'iron':10,'silicon':2},'oxygen':{'iron':15,'zeolite':1},'water':{'iron':12,'silicon':3},'habitat':{'iron':25,'titanium':5},'greenhouse':{'iron':20,'water_bottle':2},'research':{'iron':20,'aluminum':5},'beacon':{'iron':10,'silicon':2},'biodome':{'iron':35,'super_alloy':2}}
    ps=default_player_state(world_id,u['id']); inv=normalize_inventory(ps.get('inventory_json') or []); cost=costs.get(btype,costs['solar'])
    if not has_cost(inv, cost): return jsonify({'ok':False,'error':'Not enough carried resources. Open the crate or mine first.','inventory':inv}),400
    inv = pay_cost(inv, cost)
    state=state_for_world(world_id)
    if btype=='solar': state['energy']=state.get('energy',0)+10
    if btype=='oxygen': state['oxygen']=min(100,state.get('oxygen',0)+4); state['atmosphere']=min(100,state.get('atmosphere',0)+2)
    if btype=='water': state['water']=min(100,state.get('water',0)+5)
    if btype=='greenhouse': state['biodiversity']=min(100,state.get('biodiversity',0)+4); state['biomass']=min(100,state.get('biomass',0)+4); state['research']=state.get('research',0)+2
    if btype=='research': state['research']=state.get('research',0)+8
    if btype=='biodome': state['biodiversity']=min(100,state.get('biodiversity',0)+8); state['biomass']=min(100,state.get('biomass',0)+8); state['oxygen']=min(100,state.get('oxygen',0)+2)
    if btype in ['habitat','beacon']: state['atmosphere']=min(100,state.get('atmosphere',0)+1)
    state['temperature']=min(22,state.get('temperature',-40)+1); state['heat']=min(100,state.get('heat',0)+2); state['pressure']=min(100,state.get('pressure',0)+1); state['habitability']=calc_habitability(state); state['terraform_index']=state['oxygen']+state.get('heat',0)+state.get('pressure',0)+state.get('biomass',0)+state.get('water',0)
    save_world_state(world_id,state)
    sb('player_states').update({'inventory_json':inv,'updated_at':now_iso()}).eq('id',ps['id']).execute()
    building=sb('world_buildings').insert({'world_id':world_id,'building_type':btype,'x':x,'z':z,'placed_by':u['username'],'created_at':now_iso()}).execute().data[0]
    socketio.emit('building_added', building, room=f'world-{world_id}'); socketio.emit('planet_update', state, room=f'world-{world_id}')
    return jsonify({'ok':True,'planet':state,'inventory':inv,'building':building})

@socketio.on('join')
def on_join(data):
    u=current_user(); world_id=int(data.get('world_id',0)) if data else 0
    if not u or not can_access_world(world_id,u): return
    join_room(f'world-{world_id}')
    online_players[request.sid]={'user_id':u['id'],'username':u['username'],'role':u['role'],'world_id':world_id,'x':0,'z':5,'rot':0,'camera':'first'}
    players={sid:p for sid,p in online_players.items() if p['world_id']==world_id}
    emit('current_players', players)
    emit('player_joined', {'sid':request.sid, **online_players[request.sid]}, room=f'world-{world_id}', include_self=False)
    emit('chat_history', chat_history.get(world_id, [])[-30:])

@socketio.on('move')
def on_move(data):
    if request.sid not in online_players: return
    p=online_players[request.sid]; p.update({'x':data.get('x',0),'z':data.get('z',0),'rot':data.get('rot',0),'camera':data.get('camera','first'),'running':bool(data.get('running',False))})
    emit('player_moved', {'sid':request.sid, **p}, room=f'world-{p["world_id"]}', include_self=False)

@socketio.on('chat')
def on_chat(data):
    if request.sid not in online_players: return
    p=online_players[request.sid]; msg=str(data.get('message',''))[:180].strip()
    if not msg: return
    item={'username':p['username'],'message':msg,'time':datetime.utcnow().strftime('%H:%M')}
    chat_history.setdefault(p['world_id'], []).append(item)
    emit('chat', item, room=f'world-{p["world_id"]}')

@socketio.on('disconnect')
def on_disconnect():
    if request.sid in online_players:
        p=online_players.pop(request.sid); leave_room(f'world-{p["world_id"]}')
        emit('player_left', {'sid':request.sid,'username':p['username']}, room=f'world-{p["world_id"]}')

setup_start_data()
if __name__ == '__main__':
    port=int(os.environ.get('PORT',8000))
    socketio.run(app, host='0.0.0.0', port=port, debug=True, allow_unsafe_werkzeug=True)
