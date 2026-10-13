"""Second-generation, metre-scale Blender game assets.

Run Blender --background --factory-startup --python scripts/create_detailed_assets.py
Vehicle front: Blender +Y / glTF -Z. Ground: Blender Z=0 / glTF Y=0.
All meshes are original. Reference photographs are observed, not redistributed.
T3R.P dimensions: https://www.dpp.cz/vozovy-park/tramvaje/tatra-t3r-p
Cab layout reference: https://www.prazsketramvaje.cz/obrazky/vozyosobni/8335-001.jpg
"""
import bpy
import math
import sys
import random
import json
from pathlib import Path
from mathutils import Vector

sys.path.insert(0, str(Path(__file__).resolve().parent))
import create_assets as A

M=A.M
ROOT=A.ROOT
OUT=A.OUT
NATIVE=A.NATIVE
cube=A.cube
tube=A.tube
sphere=A.sphere
mesh=A.mesh
text=A.text
lathe=A.lathe
clear=A.clear

M['dash'].diffuse_color=(.115,.185,.205,1)
M['dash'].node_tree.nodes['Principled BSDF'].inputs['Base Color'].default_value=(.115,.185,.205,1)
M.update({
 'dashLabel':A.material('Cab yellow engraved switch labels',(.58,.48,.12),0,.75),
 'switch':A.material('Black Bakelite knobs',(.012,.014,.017),.1,.41),
 'pantograph':A.material('Pantograph painted ochre steel',(.72,.43,.035),.32,.51),
 'paint':A.material('Metallic car body paint',(.075,.18,.22),.62,.27),
 'carGlass':A.material('Car clear tinted glass',(.09,.15,.18),.1,.19,.58),
 'headlight':A.material('Headlamp optical lens',(.84,.9,.91),.15,.18,1,.1),
 'brake':A.material('Rear brake lamps',(.48,.008,.003),.1,.19,1,.3),
 'indicator':A.material('Amber turn indicator',(.88,.27,.018),.05,.22),
 'plate':A.material('Registration plate white',(.87,.88,.85),.04,.35),
 'denim':A.material('Denim trousers',(.095,.145,.185),0,.91),
 'coat':A.material('Coat fabric',(.205,.17,.135),0,.92),
 'skin2':A.material('Skin',(.62,.39,.26),0,.74),
 'hair2':A.material('Hair',(.045,.027,.016),0,.95),
 'lips':A.material('Face lips',(.29,.10,.075),0,.8),
 'eyeWhite':A.material('Eye sclera',(.54,.51,.46),0,.44),
 'eye':A.material('Eye iris',(.043,.037,.027),0,.35),
 'shoe':A.material('Leather shoes',(.028,.032,.027),0,.59),
 'clothingVertex':A.material('Detailed human vertex surfaces',(1,1,1),0,.83),
})
for key,mat in M.items():
    mat.use_backface_culling = key not in ('glass','carGlass')
    if key in ('glass','carGlass'):
        mat.surface_render_method='DITHERED'
        mat.use_transparent_shadow=False


def empty(name,loc=(0,0,0),parent=None):
    ob=bpy.data.objects.new(name,None)
    bpy.context.collection.objects.link(ob)
    ob.location=loc
    if parent:ob.parent=parent
    return ob


def reparent(ob,parent):
    # bpy's dependency graph otherwise returns a stale matrix after setting
    # location/rotation on a newly generated primitive (especially cylinders).
    bpy.context.view_layer.update()
    world=ob.matrix_world.copy()
    ob.parent=parent
    ob.matrix_world=world


def uv_metre(ob):
    """World-metre planar UVs, so real PBR textures work on all generated parts."""
    if ob.type!='MESH':return
    uv=ob.data.uv_layers.get('UVMap') or ob.data.uv_layers.new(name='UVMap')
    for poly in ob.data.polygons:
        n=poly.normal
        axis=max(range(3), key=lambda i:abs(n[i]))
        ij=(1,2) if axis==0 else (0,2) if axis==1 else (0,1)
        for loop in poly.loop_indices:
            p=ob.matrix_world @ ob.data.vertices[ob.data.loops[loop].vertex_index].co
            uv.data[loop].uv=(p[ij[0]],p[ij[1]])


def bake_surface_texture(mat,name,color,size=256,grain=.03):
    """Original tileable micrograin; used in GLB as well as the native .blend."""
    rng=random.Random(422)
    im=bpy.data.images.new(name,width=size,height=size)
    px=[]
    for y in range(size):
        for x in range(size):
            v=(rng.random()-.5)*grain
            weave=.004*math.sin(x*math.pi)*math.cos(y*math.pi)
            px.extend([max(0,min(1,c+v+weave)) for c in color]+[1])
    im.pixels=px
    image_dir=ROOT/'public'/'textures'/'original'
    image_dir.mkdir(parents=True,exist_ok=True)
    im.filepath_raw=str(image_dir/(name+'.png'))
    im.file_format='PNG';im.save()
    im.pack()
    node=mat.node_tree.nodes.new('ShaderNodeTexImage');node.image=im
    mat.node_tree.links.new(node.outputs['Color'],mat.node_tree.nodes['Principled BSDF'].inputs['Base Color'])


def optimize_hierarchy(exclude=()):
    bpy.context.view_layer.update()
    groups={}
    for ob in list(bpy.context.scene.objects):
        if ob.type!='MESH' or ob.name in exclude:continue
        uv_metre(ob)
        if len(ob.data.materials)==1:
            groups.setdefault((ob.parent,ob.data.materials[0]),[]).append(ob)
    for (parent,mat),obs in groups.items():
        for ob in obs:
            world=ob.matrix_world.copy();ob.parent=None;ob.matrix_world=world
        ob=A.join_objects(obs,(parent.name+'_' if parent else '')+mat.name)
        if parent:reparent(ob,parent)


def export(name,exclude=(),optimize=True):
    if optimize:optimize_hierarchy(exclude)
    bpy.ops.object.select_all(action='DESELECT')
    for ob in bpy.context.scene.objects:
        if ob.type in ('MESH','EMPTY'):
            ob.select_set(True)
            if ob.type=='MESH' and not ob.data.uv_layers:uv_metre(ob)
    bpy.ops.wm.save_as_mainfile(filepath=str(NATIVE/(name+'.blend')))
    bpy.ops.export_scene.gltf(filepath=str(OUT/(name+'.glb')),export_format='GLB',use_selection=True,export_yup=True,export_apply=True,export_materials='EXPORT',export_extras=True,export_cameras=False,export_lights=False)
    print('ASSET_DONE',name,(OUT/(name+'.glb')).stat().st_size,flush=True)


def select_export(name,objects):
    bpy.ops.object.select_all(action='DESELECT')
    for ob in objects:ob.select_set(True)
    bpy.ops.export_scene.gltf(filepath=str(OUT/(name+'.glb')),export_format='GLB',use_selection=True,export_yup=True,export_apply=True,export_extras=True,export_cameras=False,export_lights=False)
    others=[(o,list(o.users_collection)) for o in bpy.context.scene.objects if o not in objects]
    for o,cs in others:
        for c in cs:c.objects.unlink(o)
    bpy.ops.wm.save_as_mainfile(filepath=str(NATIVE/(name+'.blend')))
    for o,cs in others:
        for c in cs:c.objects.link(o)


def loft(name,sections,mat,n=24,exponent=2):
    """Closed smooth tapered elliptic/superelliptic shell, sections (z,rx,ry,cx,cy)."""
    vs=[];fs=[]
    for z,rx,ry,cx,cy in sections:
        for i in range(n):
            a=math.tau*i/n
            c,s=math.cos(a),math.sin(a)
            vs.append((cx+rx*math.copysign(abs(c)**(2/exponent),c),cy+ry*math.copysign(abs(s)**(2/exponent),s),z))
    for j in range(len(sections)-1):
        for i in range(n):fs.append((j*n+i,j*n+(i+1)%n,(j+1)*n+(i+1)%n,(j+1)*n+i))
    fs += [tuple(reversed(range(n))),tuple(range((len(sections)-1)*n,len(sections)*n))]
    return mesh(name,vs,fs,mat,True)


def rounded_console():
    # Wrap-around moulded desktop, with raised front rim. At eye height the
    # windscreen lower seal remains below the horizon, matching the reference.
    outline=[(-1.10,5.91),(-1.08,6.26),(-.88,6.56),(-.52,6.69),(0,6.72),(.64,6.62),(1.08,6.35),(1.15,5.82),(.96,5.73),(.49,5.82),(-.75,5.83)]
    vs=[]
    for z in (1.36,1.615):
        for x,y in outline:vs.append((x,y,z+.14*(y-5.82)))
    n=len(outline)
    fs=[tuple(reversed(range(n))),tuple(range(n,2*n))]+[(i,(i+1)%n,(i+1)%n+n,i+n) for i in range(n)]
    ob=mesh('Cab cast wraparound dashboard',vs,fs,M['dash'])
    bevel=ob.modifiers.new('Rounded moulded console edges','BEVEL');bevel.width=.035;bevel.segments=3
    bpy.context.view_layer.objects.active=ob;bpy.ops.object.modifier_apply(modifier=bevel.name)
    weighted=ob.modifiers.new('Cab weighted normals','WEIGHTED_NORMAL');bpy.ops.object.modifier_apply(modifier=weighted.name)
    for i in range(n):
        x,y=outline[i];x1,y1=outline[(i+1)%n]
        if y>6.25 or y1>6.25:tube('Cab raised dashboard edging',(x,y,1.67+.14*(y-5.82)),(x1,y1,1.67+.14*(y1-5.82)),.018,M['dash'])


def create_cabin():
    before=set(bpy.context.scene.objects)
    cube('Cab dark rubber floor',(-.1,5.93,1.015),(2.28,1.89,.055),M['floor'],.015)
    # Cream/grey inner nose hides exposed red paint from the driver.
    A.front_surface('Cab inner cream nose',1.01,1.70,M['interior'],6.69,.325)
    # Reverse inward to make it visible from the driver.
    inner=bpy.context.scene.objects.get('Cab inner cream nose')
    for p in inner.data.polygons:p.flip()
    cube('Cab lower partition',(-.37,4.87,1.26),(1.73,.07,.54),M['interior'],.015)
    cube('Cab partition clear glass',(-.40,4.88,2.20),(1.62,.012,1.03),M['glass'])
    for x in (-1.22,.41):tube('Cab partition seal',(x,4.89,1.05),(x,4.89,2.71),.024,M['rubber'])
    cube('Cab partition sliding door',(.80,4.88,1.94),(.68,.018,1.53),M['glass'])
    tube('Cab door vertical handrail',(.47,4.84,1.28),(.47,4.84,1.72),.018,M['steel'])
    tube('Cab driver seat column',(-.30,5.36,1.035),(-.30,5.36,1.30),.075,M['steel'])
    cube('Cab driver upholstered cushion',(-.30,5.39,1.34),(.53,.52,.12),M['black'],.075)
    back=cube('Cab driver upholstered back',(-.30,5.12,1.70),(.53,.12,.62),M['black'],.075);back.rotation_euler[0]=-.13
    for x in (-.52,-.08):tube('Cab seat support',(x,5.10,1.28),(x,5.10,1.79),.018,M['steel'])
    rounded_console()
    # Raised instrument binnacle, one circular speedometer and a narrow
    # digital equipment panel, as on the observed T3R.P cab.
    binnacle=loft('Cab speedometer raised binnacle',[(1.625,.29,.17,-.39,6.30),(1.81,.235,.125,-.39,6.33),(1.915,.20,.095,-.39,6.36)],M['dash'],32,3)
    # Gauge plane inclines 58 degrees from horizontal, facing the seated driver.
    gauge=empty('Cab_speedometer',(-.45,6.15,1.83))
    gauge.rotation_euler.x=math.radians(58)
    def gauge_tube(name,z0,z1,r,mat):
        ob=tube(name,(0,0,z0),(0,0,z1),r,mat,48);ob.parent=gauge;return ob
    gauge_tube('Cab speedometer bezel',0,.013,.122,M['black'])
    gauge_tube('Cab speedometer dial',.014,.017,.109,M['switch'])
    for i in range(41):
        angle=math.radians(135+i*6.75)
        a=(.090*math.cos(angle),.090*math.sin(angle),.019)
        b=(.103*math.cos(angle),.103*math.sin(angle),.019)
        ob=tube('Cab speed tick',a,b,.0015 if i%5 else .0023,M['white'],5);ob.parent=gauge
    for value in range(0,81,10):
        a=math.radians(135+value*3.375)
        ob=text('Cab speed numeral',str(value),(.073*math.cos(a),.073*math.sin(a),.020),.017,M['white'],(0,0,0));ob.parent=gauge
    ob=text('Cab gauge unit','km/h',(0,-.040,.021),.015,M['white'],(0,0,0));ob.parent=gauge
    needle=empty('speed_needle',(0,0,.022),gauge)
    ob=tube('Cab speed needle',(.012,-.012,0),(-.075,.075,0),.0028,M['red'],6);ob.parent=needle
    gauge_tube('Cab speed needle cap',.023,.028,.011,M['chrome'])
    cube('Cab instrument equipment screen',(-.19,6.27,1.805),(.13,.02,.17),M['black'],.009)
    text('Cab equipment digits','0',(-.19,6.253,1.835),.029,M['led'],(math.pi/2,0,0))
    text('Cab equipment indicators','JÍZDA',(-.19,6.254,1.785),.013,M['white'],(math.pi/2,0,0))
    cube('Cab lower indicator bank',(-.37,6.00,1.669),(.55,.16,.018),M['black'],.012)
    for i in range(5):
        x=-.57+i*.10
        cube('Cab indicator label',(x,6.015,1.682),(.073,.065,.008),M['dashLabel'],.002)
        cube('Cab indicator glass',(x,6.004,1.689),(.042,.034,.006),M['red'] if i==0 else M['yellow'] if i==4 else M['rubber'],.003)
    # Colour-coded screw-mounted labels around proper rotary switches.
    labels=['DVEŘE','SVĚTLA','SMĚR','TOPENÍ','STĚRAČ','ZVONEK','PÍSEK','BRZDA']
    for i,label in enumerate(labels):
        x=.05+i*.112;y=6.02
        cube('Cab switch label',(x,y,1.661),(.092,.108,.007),M['dashLabel'],.003)
        tube('Cab rotary chrome collar',(x,y+.007,1.668),(x,y+.007,1.676),.029,M['chrome'],24)
        tube('Cab rotary black switch',(x,y+.007,1.677),(x,y+.007,1.698),.024,M['switch'],16)
        knob=cube('Cab raised rotary grip',(x,y+.007,1.708),(.020,.037,.024),M['black'],.006);knob.rotation_euler.z=(-.3 if i%3 else .5)
        text('Cab engraved control label',label,(x,y+.039,1.676),.009,M['black'],(0,0,0))
        for dx in (-.038,.038):tube('Cab switch panel screw',(x+dx,y-.040,1.666),(x+dx,y-.040,1.669),.003,M['steel'],8)
    for x,y,mat in [(-.83,6.06,M['yellow']),(-.69,6.28,M['red']),(.52,6.29,M['black'])]:
        cube('Cab large control label',(x,y,1.714),(.091,.109,.008),M['dashLabel'],.005)
        tube('Cab pushbutton base',(x,y,1.72),(x,y,1.744),.037,M['chrome'],24)
        tube('Cab mushroom button',(x,y,1.745),(x,y,1.768),.039,mat,24)
    for i in range(6):
        x=.81+(i%3)*.076;y=6.35+(i//3)*.073
        z=1.685+.14*(y-5.82)
        cube('Cab far side switch label',(x,y,z),(.064,.055,.006),M['dashLabel'],.003)
        tube('Cab far side pushbutton',(x,y,z+.004),(x,y,z+.022),.019,M['red'] if i%3==1 else M['black'],16)
    # Yellow bars in front of the controls and left wing are characteristic.
    for a,b in [((-.71,5.85,1.65),(.49,5.85,1.65)),((-1.05,5.91,1.65),(-.82,5.91,1.65))]:
        tube('Cab yellow safety grab bar',a,b,.023,M['yellow'],20)
        for x,y,z in (a,b):tube('Cab grab bar mounting',(x,y,z-.066),(x,y,z),.028,M['yellow'],16)
    for i,x in enumerate((-.60,-.30,.03)):
        pedal=cube('Cab brake throttle safety pedal',(x,5.94,1.07),(.15,.24,.042),M['rubber'],.016);pedal.rotation_euler.x=-.32
        for k in range(5):tube('Cab pedal grip rib',(x-.064,5.865+k*.033,1.089),(x+.064,5.865+k*.033,1.089),.0035,M['black'],6)
    # Side terminal is canted towards the driver, with a real bezel.
    terminal=cube('Cab APEX side terminal',(-1.00,5.65,1.79),(.19,.095,.32),M['black'],.026);terminal.rotation_euler.z=-.40
    screen=cube('Cab APEX dark LCD',(-.973,5.598,1.83),(.145,.009,.16),M['carGlass'],.007);screen.rotation_euler.z=-.4
    text('Cab APEX display line','22',(-.971,5.589,1.846),.039,M['led'],(math.pi/2,0,-.4))
    cube('Cab driver sun visor',(-.47,6.70,2.59),(.80,.04,.16),M['black'],.018)
    tube('Cab rear view mirror support',(1.13,6.18,2.47),(1.59,6.40,2.47),.018,M['black'],12)
    mirror=cube('Cab exterior mirror housing',(1.58,6.41,2.46),(.19,.09,.28),M['black'],.035);mirror.rotation_euler.z=.17
    reflect=cube('Cab exterior mirror reflection',(1.58,6.36,2.46),(.147,.010,.23),M['chrome'],.024);reflect.rotation_euler.z=.17
    cube('Cab interior rear view mirror',(.91,6.30,2.53),(.28,.037,.16),M['black'],.028)
    cube('Cab interior mirror glass',(.91,6.276,2.53),(.235,.012,.116),M['chrome'],.019)
    return list(set(bpy.context.scene.objects)-before)


def create_tram():
    # Reuse dimensional underframe/door construction, replacing its cab,
    # transparent glass, one-sided nose and open roof with revised geometry.
    old_export,old_preview=A.export,A.preview
    A.export=lambda *args,**kw:None
    A.preview=lambda *args,**kw:None
    A.create_tram()
    A.export,A.preview=old_export,old_preview
    for ob in list(bpy.context.scene.objects):
        if ob.name.startswith('Cab ') or ob.name.startswith(('Windscreen wiper','Wiper blade')):
            bpy.data.objects.remove(ob,do_unlink=True)
        elif ob.name.startswith(('Pantograph diamond','Pantograph crossbar','Collector support','Collector horn','Contact bow','Pantograph spring')):
            if not ob.name.startswith(('Contact bow','Pantograph spring')):
                ob.data.materials.clear();ob.data.materials.append(M['pantograph'])
            # Runtime tram origin is rail +0.16 m; 5.34 +0.16 meets the
            # actual 5.5 m contact wire instead of floating below it.
            for v in ob.data.vertices:
                p=ob.matrix_world @ v.co
                if p.z>3.26:p.z=3.26+(p.z-3.26)*(5.34-3.26)/(4.89-3.26)
                v.co=ob.matrix_world.inverted() @ p
    # Panel seams, sill bead and skirt fasteners add vehicle scale at 1m range.
    for side in (-1,1):
        for y in (-6.55,-4.20,-1.35,1.30,4.20,6.36):
            for z in (1.02,1.54):
                tube('Skirt countersunk fastener',(side*1.255,y,z),(side*1.257,y,z),.005,M['steel'],8)
        tube('Tatra lower skirt bead',(side*1.25,-6.62,.98),(side*1.25,6.62,.98),.009,M['cream'],10)
        for y in (-3.8,2.6):
            for k in range(6):cube('Lower body inspection grille',(side*1.258,y+k*.06,1.16),(.005,.028,.15),M['black'],.003)
    for side in (-1,1):
        for i in range(-4,5):
            x=side*.84+i*.019
            half=math.sqrt(max(0,.106**2-(i*.019)**2))
            tube('Headlight prismatic lens rib',(x,7.076,1.36-half),(x,7.076,1.36+half),.0014,M['chrome'],5)
        tube('Front amber turn signal',(side*1.05,6.925,1.55),(side*1.05,6.955,1.55),.034,M['indicator'],20)
    text('Tatra emblem','TATRA',(0,7.071,1.53),.055,M['chrome'])
    cabin=create_cabin()
    door_names=[o.name for o in bpy.context.scene.objects if o.name.startswith('door_') and '_leaf' in o.name]
    # Verify and record the roof shell before material batching loses its name.
    roof=bpy.data.objects.get('Closed elliptical Tatra roof')
    counts={}
    for p in roof.data.polygons:
        ids=list(p.vertices)
        for i in range(len(ids)):
            key=tuple(sorted((ids[i],ids[(i+1)%len(ids)])))
            counts[key]=counts.get(key,0)+1
    assert all(n==2 for n in counts.values()),'Roof has open or nonmanifold edge'
    assert max(v.co.z for v in roof.data.vertices)<=3.061
    cabin_keep=[o.name for o in cabin if o.type=='EMPTY']
    # Give the cabin a shared root while retaining the instrument pivots.
    cabroot=empty('DetailedCabin')
    for ob in cabin:
        if ob.parent is None:reparent(ob,cabroot)
    optimize_hierarchy(door_names)
    cabin_objects=[cabroot]+list(cabroot.children_recursive)
    select_export('cabin',cabin_objects)
    export('tram',door_names,optimize=False)
    A.preview('tram_v2_preview',(13,18,8),(0,0,1.8),1600,950,46)
    A.preview('cabin_v2_preview',(-.30,5.35,2.06),(-.22,7.80,2.20),1400,900,lens=22)
    for name in door_names:
        leaf=bpy.data.objects[name];leaf.rotation_euler.z=leaf['openingRotation']*leaf['openingAngle']
    A.preview('doors_v2_preview',(9,11,4.8),(0,2,1.5),1280,800,38)
    for name in door_names:bpy.data.objects[name].rotation_euler.z=0
    (NATIVE/'tram_v2_validation.json').write_text(json.dumps({'roofEdges':len(counts),'roofManifold':True,'doorLeaves':len(door_names),'eyeThree':[-.30,2.06,-5.35],'front':'-Z','publishedDimensionsMetres':[2.5,3.06,15.104]},indent=2))


def create_person(variant=0):
    clear()
    palette=[
        ((.205,.17,.135),(.095,.145,.185),(.62,.39,.26),(.045,.027,.016)),
        ((.27,.053,.047),(.033,.039,.044),(.69,.45,.32),(.075,.041,.024)),
        ((.075,.11,.145),(.29,.275,.215),(.46,.265,.153),(.29,.19,.077)),
        ((.105,.155,.113),(.045,.07,.097),(.71,.50,.37),(.024,.016,.012)),
    ][variant]
    for key,c in zip(('coat','denim','skin2','hair2'),palette):
        M[key].diffuse_color=(*c,1)
        M[key].node_tree.nodes['Principled BSDF'].inputs['Base Color'].default_value=(*c,1)
    root=empty('Person')
    # Contoured shoulder, waist and pelvis: recognisable adult proportions,
    # rather than the previous sphere and rigid pipe construction.
    body=loft('Human coat torso',[(.86,.165,.102,0,0),(.98,.18,.115,0,0),(1.12,.17,.108,0,0),(1.29,.218,.125,0,-.005),(1.405,.214,.118,0,-.012),(1.445,.146,.082,0,-.017)],M['coat'],24,2.6)
    reparent(body,root)
    pelvis=loft('Human trouser pelvis',[(.79,.167,.098,0,0),(.91,.164,.105,0,0),(.96,.16,.105,0,0)],M['denim'],24,2.5);reparent(pelvis,root)
    # Visible zipper, seams, pockets and collar establish natural clothing.
    tube('Jacket zip seam',(0,.124,.93),(0,.124,1.365),.003,M['black'],6)
    for side in (-1,1):
        ob=tube('Coat pocket welt',(side*.063,.116,1.044),(side*.142,.115,1.025),.004,M['coat'],6);reparent(ob,root)
        ob=tube('Coat collar',(side*.028,.075,1.46),(side*.115,.096,1.375),.013,M['coat'],10);reparent(ob,root)
    headroot=empty('head',(0,0,0),root)
    ob=tube('Neck',(0,-.007,1.418),(0,-.007,1.545),.049,M['skin2'],24);reparent(ob,headroot)
    ob=loft('Anatomical head',[(1.495,.053,.06,0,.014),(1.52,.078,.079,0,.013),(1.565,.095,.098,0,.005),(1.64,.104,.106,0,-.003),(1.705,.091,.097,0,-.009),(1.755,.046,.06,0,-.012),(1.765,.012,.016,0,-.012)],M['skin2'],32,2.2);reparent(ob,headroot)
    # Hair shell covering forehead/top/back without a second balloon head.
    vs=[];fs=[];nr=10;ns=32
    for j in range(nr+1):
        for i in range(ns):
            a=math.tau*i/ns
            # Front hairline ends above brows; back descends toward the neck.
            end=1.20+(.43 if math.sin(a)<0 else -.08)
            t=end*j/nr
            vs.append((.115*math.sin(t)*math.cos(a),-.011+.117*math.sin(t)*math.sin(a),1.635+.145*math.cos(t)))
    for j in range(nr):
        for i in range(ns):fs.append((j*ns+i,(j+1)*ns+i,(j+1)*ns+(i+1)%ns,j*ns+(i+1)%ns))
    ob=mesh('Natural short hair shell',vs,fs,M['hair2'],True);reparent(ob,headroot)
    if variant in (1,3):
        ob=loft('Shoulder length back hair',[(1.40,.081,.045,0,-.067),(1.46,.103,.06,0,-.065),(1.56,.110,.079,0,-.04),(1.68,.095,.073,0,-.027)],M['hair2'],28,2.2)
        reparent(ob,headroot)
    ob=loft('Nose bridge',[(1.603,.023,.018,0,.102),(1.623,.020,.025,0,.11),(1.649,.012,.015,0,.108),(1.674,.010,.009,0,.100)],M['skin2'],20);reparent(ob,headroot)
    for side in (-1,1):
        ob=sphere('Human ear',(side*.102,-.005,1.633),(.022,.014,.041),M['skin2'],20,10);reparent(ob,headroot)
        ob=sphere('Eye socket',(side*.038,.096,1.658),(.022,.007,.012),M['skin2'],20,10);reparent(ob,headroot)
        ob=sphere('Eye white',(side*.038,.101,1.658),(.012,.004,.006),M['eyeWhite'],16,8);reparent(ob,headroot)
        ob=sphere('Eye iris',(side*.038,.105,1.658),(.0045,.002,.0045),M['eye'],12,8);reparent(ob,headroot)
        ob=tube('Eyebrow',(side*.022,.101,1.676),(side*.057,.094,1.679),.0025,M['hair2'],6);reparent(ob,headroot)
    ob=tube('Closed lips',(-.022,.102,1.567),(.022,.102,1.567),.0025,M['lips'],8);reparent(ob,headroot)
    # Separate limbs with anatomically located hip/shoulder pivots. Three's X
    # rotation gives a forward/back walking swing without deforming the body.
    for side,label in ((-1,'L'),(1,'R')):
        hip=empty('leg_'+label,(side*.10,0,.88),root)
        parts=[]
        parts.append(loft('Denim tailored leg',[(.12,.052,.06,side*.104,.01),(.24,.060,.063,side*.107,.006),(.45,.066,.075,side*.105,0),(.64,.083,.083,side*.10,0),(.87,.088,.091,side*.10,0)],M['denim'],20,2.7))
        parts.append(sphere('Leather shaped shoe',(side*.104,.079,.070),(.072,.15,.052),M['shoe'],24,12))
        parts.append(cube('Rubber shoe outsole',(side*.104,.077,.022),(.139,.255,.019),M['black'],.018))
        for i in range(3):parts.append(tube('Shoe lace',(side*.104-.038,.047+i*.027,.113),(side*.104+.038,.047+i*.027,.113),.002,M['shoe'],6))
        for ob in parts:reparent(ob,hip)
        shoulder=empty('arm_'+label,(side*.218,-.006,1.395),root)
        # Three successive tapered sections instead of a single pipe.
        parts=[loft('Tailored jacket sleeve',[(.977,.052,.051,side*.273,.012),(1.08,.060,.058,side*.267,.005),(1.18,.066,.062,side*.254,-.007),(1.29,.074,.071,side*.234,-.011),(1.39,.079,.082,side*.204,-.009),(1.415,.047,.051,side*.196,-.010)],M['coat'],24,2.5)]
        parts.append(tube('Jacket cuff',(side*.273,.010,.974),(side*.273,.010,.995),.055,M['coat'],20))
        parts.append(sphere('Relaxed hand palm',(side*.279,.012,.932),(.039,.027,.060),M['skin2'],20,12))
        for i in range(4):
            y=-.009+i*.015
            parts.append(tube('Relaxed individual finger',(side*.283,y,.937),(side*.290,y+.003,.884+i*.006),.006,M['skin2'],10))
        parts.append(tube('Hand thumb',(side*.248,.011,.954),(side*.240,.032,.926),.009,M['skin2'],12))
        for ob in parts:reparent(ob,shoulder)
    # Merge microdetails per limb into one vertex-coloured draw primitive;
    # preserve a distinct torso Coat fabric material for clothing variation.
    vc=M['clothingVertex'].node_tree.nodes.new('ShaderNodeVertexColor');vc.layer_name='HumanColor'
    M['clothingVertex'].node_tree.links.new(vc.outputs['Color'],M['clothingVertex'].node_tree.nodes['Principled BSDF'].inputs['Base Color'])
    for parent in list(root.children):
        if parent.type!='EMPTY':continue
        parts=[o for o in parent.children_recursive if o.type=='MESH']
        for ob in parts:
            world=ob.matrix_world.copy();ob.parent=None;ob.matrix_world=world
        combined=A.join_objects(parts,parent.name+'_detailed_surfaces')
        attrs=combined.data.color_attributes.new(name='HumanColor',type='BYTE_COLOR',domain='CORNER')
        for p in combined.data.polygons:
            color=combined.data.materials[p.material_index].diffuse_color
            for li in p.loop_indices:attrs.data[li].color=color
            p.material_index=0
        combined.data.color_attributes.active_color=attrs
        combined.data.materials.clear();combined.data.materials.append(M['clothingVertex'])
        reparent(combined,parent)
    # Parent details which did not originate inside an animated limb.
    for ob in bpy.context.scene.objects:
        if ob!=root and ob.parent is None:reparent(ob,root)
    if variant in (1,3):root.scale=(.94,.96,.94)
    name='pedestrian' if variant==0 else 'pedestrian_'+str(variant+1)
    export(name)
    A.preview(name+'_v2_preview',(3,5,2.5),(0,0,.96),1050,1100,lens=60)


def create_vehicle(kind='wagon'):
    clear()
    name={'wagon':'car','hatchback':'hatchback','van':'van'}[kind]
    isvan=kind=='van';ishatch=kind=='hatchback'
    half=2.32 if kind=='wagon' else 2.10 if ishatch else 2.50
    w=.895 if not isvan else .99
    wheelbase=2.71 if not isvan else 3.02
    radius=.318 if not isvan else .36
    root=empty('Vehicle_'+kind)
    # Real wheel arches are modelled as lower side cutouts, not wheels glued
    # onto a box. A loft wraps bumper/hood surfaces over a gently bowed waist.
    sections=[(-half,.77 if not isvan else .94,.78),(-half+.13,w,.91),(-half+.48,w,.985),(-.90,w,.985),(.58,w,1.0),(half-.60,w-.01,.96),(half-.15,w-.10,.89),(half,w-.20,.76)]
    vs=[];fs=[]
    for y,ww,z in sections:
        vs += [(-ww,y,.43),(-ww,y,.78),(-ww*.94,y,z),(0,y,z+.045),(ww*.94,y,z),(ww,y,.78),(ww,y,.43)]
    stride=7
    for j in range(len(sections)-1):
        for i in range(stride-1):
            # Lower vertical side skins are separately built with wheel cuts.
            if i not in (0,5):fs.append((j*stride+i,j*stride+i+1,(j+1)*stride+i+1,(j+1)*stride+i))
    fs.extend([tuple(reversed(range(stride))),tuple(range((len(sections)-1)*stride,len(sections)*stride))])
    ob=mesh('Curved body paint shell',vs,fs,M['paint'],True);reparent(ob,root)
    # Side skins with sampled arch openings, matching the tyre position.
    for side in (-1,1):
        ys=sorted(set([-half+.08,-half+.30,half-.3,half-.08]+[i*.09-half+.08 for i in range(int((2*half-.16)/.09)+1)]))
        verts=[]
        for y in ys:
            low=.43
            for cy in (-wheelbase/2,wheelbase/2):
                d=y-cy
                if abs(d)<radius+.062:low=max(low,.35+math.sqrt(max(0,(radius+.065)**2-d*d)))
            ww=w-.075*(max(0,abs(y)-(half-.5))/.5)**2
            verts.extend([(side*ww,y,low),(side*ww,y,.885)])
        faces=[(i*2,i*2+1,i*2+3,i*2+2) for i in range(len(ys)-1)]
        ob=mesh('Wheel arch side paint',verts,faces if side==-1 else [tuple(reversed(f)) for f in faces],M['paint'],True);reparent(ob,root)
        for cy in (-wheelbase/2,wheelbase/2):
            for i in range(20):
                a=math.pi*i/20;b=math.pi*(i+1)/20
                ob=tube('Body wheel arch lip',(side*(w+.006),cy+(radius+.066)*math.cos(a),.35+(radius+.066)*math.sin(a)),(side*(w+.006),cy+(radius+.066)*math.cos(b),.35+(radius+.066)*math.sin(b)),.011,M['paint'],8);reparent(ob,root)
    # Roof/cabin mesh: raised van windshield, wagon five windows or shorter
    # hatchback. Window surround remains painted and glass has real pillars.
    roofz=1.59 if not isvan else 2.15
    rearroof=-1.43 if not ishatch else -1.19
    frontroof=.47 if not isvan else .76
    rearbase=-1.98 if kind=='wagon' else -1.65 if ishatch else -2.25
    frontbase=1.18 if not isvan else 1.42
    rw=.735 if not isvan else .88
    rv=[];rf=[];nr=24
    for y,ww in [(rearroof,rw*.98),(rearroof+.14,rw),(frontroof-.13,rw),(frontroof,rw*.98)]:
        for i in range(nr+1):
            xx=-ww+2*ww*i/nr
            zz=roofz-.01+.052*(1-(xx/ww)**2)
            rv.append((xx,y,zz))
    for j in range(3):
        for i in range(nr):rf.append((j*(nr+1)+i,j*(nr+1)+i+1,(j+1)*(nr+1)+i+1,(j+1)*(nr+1)+i))
    ob=mesh('Curved roof body paint',rv,rf,M['paint'],True);reparent(ob,root)
    # Front and back glazing are slightly curved, segmented clear surfaces.
    for front,y0,y1 in [(True,frontbase,frontroof),(False,rearbase,rearroof)]:
        n=18;vs=[]
        for j in range(2):
            for i in range(n+1):
                x=-1+2*i/n
                xx=x*(w*.895 if j==0 else rw*.96)
                y=(y0 if j==0 else y1)+(.035 if front else -.035)*(1-x*x)
                z=.96 if j==0 else roofz-.035
                vs.append((xx,y,z))
        fs=[(i,i+1,i+1+n+1,i+n+1) for i in range(n)]
        ob=mesh('Front windshield' if front else 'Rear glass',vs,[tuple(reversed(f)) for f in fs] if front else fs,M['carGlass'],True);reparent(ob,root)
        for row in (0,n+1):
            for i in range(n):
                ob=tube('Windscreen perimeter seal',vs[row+i],vs[row+i+1],.016,M['black'],8);reparent(ob,root)
        for side in (-1,1):
            ob=tube('Painted cabin A D pillars',(side*w*.91,y0,.96),(side*rw,y1,roofz-.015),.055,M['paint'],12);reparent(ob,root)
    for side in (-1,1):
        for ya,yb in [(rearbase,rearroof),(rearroof,-.52),(-.52,.38),(.38,frontroof),(frontroof,frontbase)]:
            def p(y,top):
                yy=max(rearroof,min(frontroof,y)) if top else y
                xx=side*(rw-.01 if top else w*.945)
                return (xx,yy,roofz-.08 if top else .965)
            verts=[p(ya,False),p(yb,False),p(yb,True),p(ya,True)]
            ob=mesh('Side glass clear window',verts,[(0,1,2,3)] if side==-1 else [(3,2,1,0)],M['carGlass']);reparent(ob,root)
            for a,b in [(verts[0],verts[1]),(verts[2],verts[3])]:
                ob=tube('Side glazing seals',a,b,.014,M['black'],8);reparent(ob,root)
        for y in (-.52,.38):
            ob=tube('Black window B C pillars',(side*w*.95,y,.96),(side*rw,y,roofz-.03),.044,M['black'],10);reparent(ob,root)
        ob=tube('Door lower sill trim',(side*(w+.002),-half+.35,.46),(side*(w+.002),half-.45,.46),.028,M['black'],10);reparent(ob,root)
        for y in (-.42,.96):
            ob=cube('Chrome door handle',(side*(w+.010),y,.82),(.025,.165,.024),M['chrome'],.009);reparent(ob,root)
            ob=tube('Door vertical panel gap',(side*(w+.008),y-.24,.48),(side*(w+.008),y-.24,.95),.0035,M['black'],6);reparent(ob,root)
        ob=tube('Side mirror stalk',(side*w,.84,1.055),(side*(w+.16),.81,1.16),.023,M['black'],10);reparent(ob,root)
        ob=cube('Painted mirror housing',(side*(w+.18),.80,1.185),(.21,.16,.104),M['paint'],.042);reparent(ob,root)
        ob=cube('Mirror reflective insert',(side*(w+.18),.71,1.182),(.17,.007,.074),M['chrome'],.023);reparent(ob,root)
    # Interior dash, driver, seats and steering wheel are visible through glass.
    ob=cube('Car dashboard',(0,.94,1.05),(1.52,.35,.10),M['black'],.045);reparent(ob,root)
    for x in (-.38,.38):
        for y in (-.61,.33):
            ob=cube('Car upholstered seat cushion',(x,y,.72),(.42,.44,.12),M['black'],.048);reparent(ob,root)
            ob=cube('Car upholstered seat back',(x,y-.21,1.00),(.43,.11,.52),M['black'],.055);reparent(ob,root)
            ob=cube('Car head restraint',(x,y-.23,1.31),(.26,.09,.13),M['black'],.032);reparent(ob,root)
    for i in range(24):
        a=math.tau*i/24;b=math.tau*(i+1)/24
        ob=tube('Steering wheel',(-.38+.15*math.cos(a),.78,1.01+.15*math.sin(a)),(-.38+.15*math.cos(b),.78,1.01+.15*math.sin(b)),.012,M['black'],8);reparent(ob,root)
    ob=sphere('Driver head',(-.38,.26,1.28),(.084,.075,.11),M['skin2'],16,10);reparent(ob,root)
    ob=sphere('Driver shoulder',(-.38,.28,1.02),(.17,.10,.22),M['coat'],16,10);reparent(ob,root)
    for side,label in ((-1,'L'),(1,'R')):
        for cy,which in ((wheelbase/2,'F'),(-wheelbase/2,'R')):
            wheel=empty('wheel_'+which+label,(side*w,cy,radius),root)
            obs=[]
            obs.append(tube('Tyre sidewall',(side*(w-.12),cy,radius),(side*(w+.04),cy,radius),radius,M['rubber'],40))
            obs.append(tube('Machined alloy wheel',(side*(w+.045),cy,radius),(side*(w+.052),cy,radius),radius*.70,M['black'],40))
            for j in range(5):
                a=j*math.tau/5
                obs.append(tube('Alloy Y spoke',(side*(w+.058),cy+.06*math.cos(a),radius+.06*math.sin(a)),(side*(w+.058),cy+.21*math.cos(a),radius+.21*math.sin(a)),.019,M['chrome'],8))
            obs.append(tube('Alloy wheel centre cap',(side*(w+.060),cy,radius),(side*(w+.068),cy,radius),.053,M['steel'],20))
            for ob in obs:reparent(ob,wheel)
    # Bumpers, grilles, optical lenses, lamps and actual Czech-sized plates.
    for front,yy in ((True,half+.017),(False,-half-.014)):
        ob=cube('Bumper black lower insert',(0,yy,.48),(1.57 if not isvan else 1.8,.04,.16),M['black'],.045);reparent(ob,root)
        ob=cube('Registration plate',(0,yy+(.026 if front else -.026),.64),(.52,.012,.11),M['plate'],.008);reparent(ob,root)
        ob=cube('Plate EU blue stripe',(-.23,yy+(.035 if front else -.035),.64),(.034,.006,.089),M['blue'],.002);reparent(ob,root)
        ob=text('Czech registration','4A6 8322',(0,yy+(.036 if front else -.036),.641),.050,M['black'],(math.pi/2,0,math.pi if front else 0));reparent(ob,root)
    ob=cube('Chrome grille surround',(0,half+.015,.805),(.70,.032,.23),M['chrome'],.048);reparent(ob,root)
    ob=cube('Black front radiator grille',(0,half+.036,.804),(.638,.012,.182),M['black'],.027);reparent(ob,root)
    for x in (-.25,-.15,-.05,.05,.15,.25):
        ob=tube('Grille chrome blade',(x,half+.045,.73),(x,half+.045,.88),.005,M['chrome'],6);reparent(ob,root)
    for side in (-1,1):
        ob=cube('Headlamp curved housing',(side*.59,half-.025,.88),(.45,.105,.134),M['black'],.047);reparent(ob,root)
        ob=cube('Headlamp clear optical lens',(side*.59,half+.035,.88),(.42,.012,.105),M['headlight'],.035);reparent(ob,root)
        for dx in (-.09,.09):
            ob=tube('Headlamp projector lens',(side*.59+dx,half+.046,.88),(side*.59+dx,half+.049,.88),.035,M['chrome'],20);reparent(ob,root)
        ob=cube('Rear brake lamp',(side*.67,-half-.034,.882),(.27,.032,.17),M['brake'],.038);reparent(ob,root)
        ob=cube('Rear lamp white reversing strip',(side*.67,-half-.056,.857),(.24,.008,.026),M['headlight'],.008);reparent(ob,root)
    for x in (-.32,.32):
        ob=tube('Windshield wiper',(x,.99,1.14),(x-.19,.77,1.36),.005,M['black'],8);reparent(ob,root)
    if kind=='wagon':
        for side in (-1,1):
            ob=tube('Wagon longitudinal roof rail',(side*.62,-1.24,roofz+.068),(side*.62,.32,roofz+.068),.018,M['chrome'],12);reparent(ob,root)
            for y in (-1.18,.27):
                ob=tube('Roof rail foot',(side*.62,y,roofz+.014),(side*.62,y,roofz+.068),.025,M['black'],10);reparent(ob,root)
    if isvan:
        # Panel van sides rather than transparent minibus walls.
        for side in (-1,1):
            ob=cube('Van painted cargo panel',(side*.95,-1.025,1.495),(.065,2.3,1.08),M['paint'],.042);reparent(ob,root)
            ob=tube('Van side sliding door gap',(side*.99,-.16,.97),(side*.99,-.16,2.06),.005,M['black'],8);reparent(ob,root)
    export(name)
    A.preview(name+'_v2_preview',(7,10,5),(0,0,.87),1250,800,lens=58)


if __name__=='__main__':
    bake_surface_texture(M['floor'],'rubber_floor_grain',(.068,.071,.063),256,.017)
    bake_surface_texture(M['dash'],'worn_cab_enamel',(.115,.185,.205),256,.012)
    create_tram()
    for variant in range(4):create_person(variant)
    create_vehicle('wagon')
    create_vehicle('hatchback')
    create_vehicle('van')
    print('DETAILED_ASSETS_COMPLETE',flush=True)
