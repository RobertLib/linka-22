"""Detailed, metre-scale Blender game assets with articulated traffic rigs.

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
import argparse
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
 'carInterior':A.material('Automotive charcoal upholstery',(.035,.043,.052),0,.86),
 'tire':A.material('Tyre rubber with satin sidewalls',(.018,.022,.025),0,.8),
 'seam':A.material('Recessed automotive panel seams',(.008,.011,.014),.1,.7),
 'eyelid':A.material('Natural eyelid shadow',(.29,.16,.105),0,.88),
 'shirt':A.material('Neutral cotton shirt',(.61,.60,.55),0,.92),
 'bag':A.material('Canvas shoulder bag',(.13,.115,.08),0,.94),
 'headlampGlass':A.material('Headlamp smoked optical cover',(.18,.23,.26),.12,.14,.58),
 'reversingLens':A.material('Clear reversing optical lens',(.52,.56,.55),.08,.21),
 'plateBlue':A.material('Registration EU blue',(.012,.048,.33),.05,.4),
})
M['carGlass'].diffuse_color=(.052,.091,.112,.72)
M['carGlass'].node_tree.nodes['Principled BSDF'].inputs['Base Color'].default_value=(.052,.091,.112,.72)
M['carGlass'].node_tree.nodes['Principled BSDF'].inputs['Alpha'].default_value=.72
M['paint'].node_tree.nodes['Principled BSDF'].inputs['Coat Weight'].default_value=.35
M['paint'].node_tree.nodes['Principled BSDF'].inputs['Coat Roughness'].default_value=.19
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
        group_name=(parent.name+'_' if parent else '')+mat.name
        if len(obs)==1:
            obs[0].name=group_name
            continue
        for ob in obs:
            world=ob.matrix_world.copy();ob.parent=None;ob.matrix_world=world
        ob=A.join_objects(obs,group_name)
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


def orient_mesh(name, verts, faces, mat, outward, smooth=True):
    """Orient an exposed sheet towards its exterior (all assets are culled)."""
    direction=Vector(outward)
    oriented=[]
    for f in faces:
        normal=(Vector(verts[f[1]])-Vector(verts[f[0]])).cross(Vector(verts[f[2]])-Vector(verts[f[0]]))
        oriented.append(tuple(reversed(f)) if normal.dot(direction)<0 else f)
    return mesh(name,verts,oriented,mat,smooth)


def polyline(name,points,r,mat,parent,n=8):
    for a,b in zip(points,points[1:]):reparent(tube(name,a,b,r,mat,n),parent)


def human_surface(name,sections,mat,n=28,fold=.0):
    ob=loft(name,sections,mat,n,2.15)
    # Broad irregular folds affect the silhouette, rather than painted lines.
    for v in ob.data.vertices:
        angle=math.atan2(v.co.y,v.co.x)
        offset=fold*(math.sin(v.co.z*38+angle*3)+.45*math.sin(v.co.z*61-angle*5))
        v.co.x += math.cos(angle)*offset
        v.co.y += math.sin(angle)*offset
    ob.data.update()
    # End caps sit inside adjoining garments; flat cap normals prevent the
    # characteristic dark segmented-arm/knee bands of smooth closed tubes.
    for polygon in ob.data.polygons[-2:]:polygon.use_smooth=False
    return ob


def world_empty(name,location,parent):
    ob=empty(name,location)
    reparent(ob,parent)
    return ob


def optical_cluster(name,side,half,outline,mat,parent,inset=0,height_offset=0):
    """A solid lamp follows the rounded fascia instead of protruding as a box."""
    vs=[]
    for depth in (-.018,.004):
        for x,z in outline:
            x=side*x
            vs.append((x,half+.057-.088*(abs(x)/.84)**4+depth+inset,z+height_offset))
    n=len(outline)
    faces=[tuple(reversed(range(n))),tuple(range(n,n*2))]
    faces += [(i,(i+1)%n,(i+1)%n+n,i+n) for i in range(n)]
    ob=mesh(name,vs,faces,mat)
    # Recalculate volume normals before applying manufactured edge rounding.
    bpy.context.view_layer.objects.active=ob
    ob.select_set(True);bpy.ops.object.mode_set(mode='EDIT');bpy.ops.mesh.select_all(action='SELECT');bpy.ops.mesh.normals_make_consistent(inside=False);bpy.ops.object.mode_set(mode='OBJECT');ob.select_set(False)
    bevel=ob.modifiers.new('Rounded optical edge','BEVEL');bevel.width=.008;bevel.segments=3
    bpy.ops.object.modifier_apply(modifier=bevel.name)
    for p in ob.data.polygons:p.use_smooth=True
    bevel=ob.modifiers.new('Optical weighted normals','WEIGHTED_NORMAL');bpy.ops.object.modifier_apply(modifier=bevel.name)
    reparent(ob,parent);return ob


def merge_human_details(root):
    vc=M['clothingVertex'].node_tree.nodes.get('Human vertex colours')
    if not vc:
        vc=M['clothingVertex'].node_tree.nodes.new('ShaderNodeVertexColor')
        vc.name='Human vertex colours';vc.layer_name='HumanColor'
        M['clothingVertex'].node_tree.links.new(vc.outputs['Color'],M['clothingVertex'].node_tree.nodes['Principled BSDF'].inputs['Base Color'])
    # Direct children only: knee/elbow joints must survive mesh consolidation.
    for parent in [o for o in root.children_recursive if o.type=='EMPTY']:
        parts=[o for o in parent.children if o.type=='MESH' and o.data.materials[0]!=M['coat'] and o.data.materials[0]!=M['denim']]
        if not parts:continue
        for ob in parts:
            world=ob.matrix_world.copy();ob.parent=None;ob.matrix_world=world
        combined=A.join_objects(parts,parent.name+'_detailed_surfaces') if len(parts)>1 else parts[0]
        combined.name=parent.name+'_detailed_surfaces'
        attrs=combined.data.color_attributes.new(name='HumanColor',type='BYTE_COLOR',domain='CORNER')
        for p in combined.data.polygons:
            color=combined.data.materials[p.material_index].diffuse_color
            for li in p.loop_indices:attrs.data[li].color=color
            p.material_index=0
        combined.data.color_attributes.active_color=attrs
        combined.data.materials.clear();combined.data.materials.append(M['clothingVertex'])
        reparent(combined,parent)


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
    root['assetVersion']=3;root['heightMetres']=1.77
    torso=empty('torso',(0,0,1.02),root)
    female=variant in (1,3)
    chest=.195 if female else .213
    def add(ob,parent=torso):reparent(ob,parent);return ob
    add(human_surface('Tailored coat torso',[(.865,.158,.10,0,.003),(.92,.175,.111,0,0),(1.03,.162 if female else .174,.108,0,-.004),(1.15,.151 if female else .171,.105,0,-.008),(1.27,chest,.121,0,-.009),(1.325,chest,.119,0,-.012),(1.365,chest-.012,.112,0,-.014),(1.395,.166,.091,0,-.016),(1.425,.122,.071,0,-.016),(1.447,.077,.055,0,-.015)],M['coat'],32,.0018))
    add(human_surface('Natural trouser pelvis',[(.78,.156,.10,0,-.012),(.84,.172,.112,0,-.013),(.91,.168,.109,0,-.009),(.945,.154,.099,0,-.01)],M['denim'],28,.002))
    add(cube('Shirt visible collar insert',(0,.055,1.422),(.088,.04,.082),M['shirt'],.018))
    add(loft('Relaxed rounded jacket collar',[(1.412,.082,.066,0,-.012),(1.437,.078,.064,0,-.012),(1.457,.066,.054,0,-.012)],M['coat'],28))
    polyline('Jacket stitched centre',[(0,.115,.91),(0,.123,1.05),(0,.116,1.22),(0,.105,1.38)],.0018,M['seam'],torso,6)
    for side in (-1,1):
        polyline('Inset coat pocket',[(side*.073,.112,1.015),(side*.139,.097,1.04)],.002,M['seam'],torso,6)
        polyline('Jacket pocket stitched welt',[(side*.073,.115,1.009),(side*.141,.102,1.034)],.0025,M['coat'],torso,6)
    # Sculpted facial surface: rounded cranium, flatter temples, cheekbones and
    # a narrow jaw/chin. Geometry, not oversized painted eyes, defines the face.
    head=world_empty('head',(0,-.008,1.49),torso)
    add(tube('Neck',(0,-.014,1.423),(0,-.01,1.56),.047,M['skin2'],20),head)
    sections=[(1.51,.031,.048,0,.023),(1.53,.059,.068,0,.015),(1.555,.077,.078,0,.005),(1.586,.093,.089,0,-.006),(1.625,.098,.096,0,-.012),(1.66,.092,.095,0,-.015),(1.70,.087,.087,0,-.02),(1.737,.063,.066,0,-.023),(1.758,.028,.034,0,-.023),(1.765,.004,.006,0,-.023)]
    face=loft('Sculpted human face',sections,M['skin2'],36,2)
    for v in face.data.vertices:
        x,y,z=v.co
        if y>0:
            # Recess orbital plane and push cheeks below it forward subtly.
            orbital=math.exp(-((abs(x)-.035)/.026)**2-((z-1.649)/.019)**2)
            cheeks=math.exp(-((abs(x)-.059)/.025)**2-((z-1.614)/.022)**2)
            v.co.y+=.005*cheeks-.006*orbital
    add(face,head)
    # Nose shares the same skin material and blends into the face at its root.
    add(loft('Rounded nose bridge',[(1.59,.018,.012,0,.080),(1.604,.020,.021,0,.092),(1.619,.016,.025,0,.098),(1.64,.012,.02,0,.091),(1.661,.008,.009,0,.080)],M['skin2'],16),head)
    for side in (-1,1):
        add(sphere('Nose alar wing',(side*.015,.094,1.608),(.011,.012,.009),M['skin2'],12,6),head)
        add(sphere('Subtle nostril',(side*.011,.104,1.603),(.004,.003,.0018),M['eyelid'],10,5),head)
        add(sphere('Anatomical ear',(side*.097,-.018,1.63),(.018,.012,.032),M['skin2'],16,8),head)
        add(sphere('Ear concha',(side*.108,-.011,1.633),(.004,.008,.019),M['eyelid'],12,6),head)
        add(sphere('Small natural eye',(side*.034,.077,1.65),(.012,.003,.0044),M['eyeWhite'],14,6),head)
        add(sphere('Eye pupil',(side*.034,.080,1.65),(.0033,.0015,.0033),M['eye'],10,5),head)
        polyline('Upper eyelid',[(side*.023,.081,1.651),(side*.034,.083,1.654),(side*.046,.077,1.65)],.0014,M['eyelid'],head,6)
        polyline('Natural eyebrow',[(side*.021,.079,1.666),(side*.034,.081,1.668),(side*.052,.073,1.663)],.0022,M['hair2'],head,6)
    add(sphere('Upper lip',(0,.086,1.574),(.021,.004,.0033),M['lips'],18,6),head)
    add(sphere('Lower lip',(0,.086,1.568),(.017,.004,.003),M['lips'],16,6),head)
    polyline('Mouth line',[(-.019,.089,1.571),(0,.091,1.57),(.019,.089,1.571)],.0008,M['eyelid'],head,5)
    # Asymmetric parting with a smooth non-spherical silhouette.
    vs=[];fs=[];nr=8;ns=32
    for j in range(nr+1):
        for i in range(ns):
            a=math.tau*i/ns
            end=1.67 if math.sin(a)<0 else 1.05+.07*math.cos(a)
            t=end*j/nr
            vs.append((.10*math.sin(t)*math.cos(a),-.022+.102*math.sin(t)*math.sin(a),1.649+.127*math.cos(t)+.005*math.cos(a)*math.sin(t)))
    for j in range(nr):
        for i in range(ns):fs.append((j*ns+i,(j+1)*ns+i,(j+1)*ns+(i+1)%ns,j*ns+(i+1)%ns))
    add(mesh('Sculpted parted hair',vs,fs,M['hair2'],True),head)
    if female:
        add(human_surface('Shoulder length hair',[(1.41,.074,.029,0,-.077),(1.47,.097,.043,0,-.081),(1.56,.105,.056,0,-.065),(1.65,.096,.066,0,-.046),(1.7,.077,.049,0,-.045)],M['hair2'],24,.002),head)
    elif variant==2:
        # One older commuter with subtle glasses and a soft knit scarf.
        for side in (-1,1):
            polyline('Thin spectacles',[(side*.019,.087,1.658),(side*.052,.082,1.658),(side*.053,.082,1.642),(side*.019,.087,1.642),(side*.019,.087,1.658)],.0016,M['steel'],head,6)
        polyline('Spectacle bridge',[(-.019,.088,1.653),(0,.093,1.656),(.019,.088,1.653)],.0013,M['steel'],head,6)
    # Articulated legs and arms have anatomical knees and elbows. All positions
    # are in metres; existing hip/shoulder contracts are kept for old clients.
    for side,label in ((-1,'L'),(1,'R')):
        hip=empty('leg_'+label,(side*.095,0,.86),root)
        knee=world_empty('knee_'+label,(side*.098,.014,.47),hip)
        add(human_surface('Trouser upper leg',[(.435,.062,.065,side*.098,.012),(.5,.068,.075,side*.098,.011),(.64,.080,.089,side*.096,-.002),(.78,.086,.094,side*.093,-.009),(.865,.082,.089,side*.094,-.008)],M['denim'],24,.0027),hip)
        add(human_surface('Trouser lower leg',[(.13,.052,.059,side*.104,.008),(.18,.055,.06,side*.104,.011),(.29,.061,.069,side*.103,.003),(.38,.064,.068,side*.101,.008),(.47,.062,.065,side*.098,.012)],M['denim'],24,.003),knee)
        add(loft('Shaped leather shoe',[(.019,.060,.119,side*.104,.079),(.037,.066,.137,side*.104,.078),(.072,.067,.138,side*.104,.074),(.109,.058,.096,side*.104,.035),(.13,.04,.046,side*.104,-.008)],M['shoe'],24,2.6),knee)
        add(cube('Rounded rubber shoe sole',(side*.104,.079,.023),(.133,.278,.031),M['tire'],.013),knee)
        for i in range(3):polyline('Shoe laces',[(side*.104-.030,.016+i*.022,.12-i*.003),(side*.104+.030,.019+i*.022,.12-i*.003)],.0017,M['shirt'],knee,5)
        shoulder=world_empty('arm_'+label,(side*.205,-.012,1.375),torso)
        elbow=world_empty('elbow_'+label,(side*.255,-.004,1.126),shoulder)
        add(human_surface('Jacket upper sleeve',[(1.105,.051,.055,side*.255,-.001),(1.16,.057,.062,side*.249,-.005),(1.22,.066,.068,side*.241,-.009),(1.28,.074,.074,side*.228,-.014),(1.33,.081,.081,side*.216,-.017),(1.365,.082,.081,side*.208,-.018),(1.397,.073,.071,side*.198,-.019),(1.417,.055,.055,side*.190,-.018),(1.432,.027,.029,side*.184,-.017),(1.437,.002,.003,side*.180,-.017)],M['coat'],24,.0013),shoulder)
        add(human_surface('Bent forearm sleeve',[(.944,.047,.047,side*.267,.053),(.99,.052,.053,side*.267,.038),(1.075,.055,.058,side*.264,.009),(1.136,.056,.059,side*.254,-.001)],M['coat'],24,.0023),elbow)
        add(sphere('Natural folded elbow',(side*.254,-.001,1.125),(.058,.060,.042),M['coat'],20,10),elbow)
        add(loft('Jacket cuff',[(.943,.049,.05,side*.267,.053),(.965,.051,.052,side*.267,.048)],M['coat'],20),elbow)
        add(sphere('Natural hand',(side*.27,.059,.908),(.035,.024,.053),M['skin2'],16,8),elbow)
        for i in range(4):
            add(tube('Relaxed curved finger',(side*.275,-.003+i*.013+.057,.918),(side*.28,.057+i*.013-.003,.868+i*.004),.0055,M['skin2'],8),elbow)
        add(tube('Relaxed thumb',(side*.241,.06,.926),(side*.238,.078,.903),.008,M['skin2'],10),elbow)
    if variant in (1,2):
        # Canvas cross-body bag fixed to the torso, with a visible woven strap.
        add(cube('Commuter shoulder bag',(.17,-.082,1.025),(.14,.17,.24),M['bag'],.029))
        polyline('Cross body bag strap',[(-.17,.083,1.403),(-.07,.135,1.286),(.07,.127,1.154),(.17,.10,1.05)],.008,M['bag'],torso,8)
    merge_human_details(root)
    if female:root.scale=(.95,.96,.95)
    name='pedestrian' if variant==0 else 'pedestrian_'+str(variant+1)
    export(name)
    if not OPTIONS.no_previews:A.preview(name+'_v2_preview',(2.8,5,2.3),(0,0,.96),1050,1100,lens=60)


def wheel_surface(name,cy,z,side,w,profile,mat,parent,segments=44,half=False):
    vs=[];fs=[]
    for axial,radius in profile:
        for i in range(segments):
            t=(-math.pi/2+math.pi*i/(segments-1)) if half else math.tau*i/segments
            vs.append((side*(w+axial),cy+radius*math.sin(t),z+radius*math.cos(t)))
    for j in range(len(profile)-1):
        for i in range(segments-1 if half else segments):
            f=(j*segments+i,j*segments+(i+1)%segments,(j+1)*segments+(i+1)%segments,(j+1)*segments+i)
            fs.append(tuple(reversed(f)) if side>0 else f)
    ob=mesh(name,vs,fs,mat,True);reparent(ob,parent);return ob


def create_vehicle(kind='wagon'):
    clear()
    # Each asset is reproducible independently of which person variants were
    # generated earlier in the same Blender process.
    for key,color in [('coat',(.205,.17,.135)),('skin2',(.62,.39,.26)),('hair2',(.045,.027,.016))]:
        M[key].diffuse_color=(*color,1)
        M[key].node_tree.nodes['Principled BSDF'].inputs['Base Color'].default_value=(*color,1)
    name={'wagon':'car','hatchback':'hatchback','van':'van'}[kind]
    isvan=kind=='van';ishatch=kind=='hatchback'
    half=2.32 if kind=='wagon' else 2.10 if ishatch else 2.50
    w=.895 if not isvan else .99
    wheelbase=3.02 if isvan else 2.57 if ishatch else 2.71
    radius=.36 if isvan else .318
    root=empty('Vehicle_'+kind)
    root['assetVersion']=3;root['wheelRadius']=radius;root['wheelbase']=wheelbase;root['widthMetres']=2*w;root['lengthMetres']=2*half
    body=empty('dynamic_body',(0,0,.66),root)
    def add(ob,parent=body):reparent(ob,parent);return ob
    # Continuous body skin: the shoulder rises above the arch while the waist
    # follows an actual fender opening. Rounded nose/tail are welded into the
    # shell, avoiding squared plates protruding from the bonnet.
    def breadth(y):return w*(1-.095*(abs(y)/half)**5)
    def shoulder(y):return (.995 if isvan else .865)+.026*math.cos(y*1.1)-.024*(abs(y)/half)**6
    steps=104;ys=[-half+2*half*i/steps for i in range(steps+1)]
    for side in (-1,1):
        vs=[];fs=[]
        for y in ys:
            low=.30 if isvan else .29
            for cy in (-wheelbase/2,wheelbase/2):
                d=y-cy;arch=radius+.061
                if abs(d)<arch:low=max(low,radius+math.sqrt(max(0,arch*arch-d*d)))
            ww=breadth(y);top=shoulder(y)
            for j in range(5):
                t=j/4;z=low+(top-low)*t
                xx=ww*(.99+.012*math.sin(t*math.pi)-.038*t*t)
                vs.append((side*xx,y,z))
        for i in range(steps):
            for j in range(4):fs.append((i*5+j,(i+1)*5+j,(i+1)*5+j+1,i*5+j+1))
        add(orient_mesh('Sculpted fender and doors',vs,fs,M['paint'],(side,0,0)))
        for cy in (-wheelbase/2,wheelbase/2):
            points=[]
            for i in range(31):
                a=math.pi*i/30
                points.append((side*(breadth(cy)+(0 if isvan else .003)),cy+(radius+.061)*math.cos(a),radius+(radius+.061)*math.sin(a)))
            polyline('Rolled fender lip',points,.007,M['paint'],body,6)
            # Inner arch surfaces provide a dark wheel well instead of sky gaps.
            wheel_surface('Recessed wheel well',cy,radius,side,w,[(-.16,radius+.055),(-.07,radius+.055)],M['seam'],body,24,half=True)
    frontbase=1.10 if not isvan else 1.41
    rearbase=-1.89 if kind=='wagon' else -1.61 if ishatch else -2.39
    frontroof=.34 if not isvan else .80
    rearroof=-1.31 if kind=='wagon' else -.99 if ishatch else -2.36
    roofz=(1.445 if kind=='wagon' else 1.415) if not isvan else 2.14
    rw=.726 if not isvan else .87
    # Hood/deck are transverse domed grids, with a rounded leading nose.
    for ya,yb,label in [(frontbase,half,'Bonnet'),(-half,rearbase,'Rear deck')]:
        vs=[];fs=[];ny=12;nx=20
        for j in range(ny+1):
            y=ya+(yb-ya)*j/ny
            for i in range(nx+1):
                a=-1+2*i/nx;ww=breadth(y)*.962
                progress=j/ny if label=='Bonnet' else 1-j/ny
                sy=1 if label=='Bonnet' else -1
                rounded_y=y+sy*(.04-.14*abs(a)**4)*progress**5
                vs.append((ww*a,rounded_y,shoulder(y)+.040*(1-a*a)))
        for j in range(ny):
            for i in range(nx):
                k=j*(nx+1)+i;fs.append((k,k+1,k+nx+2,k+nx+1))
        add(orient_mesh(label+' sculpted surface',vs,fs,M['paint'],(0,0,1)))
        for side in (-1,1):
            polyline(label+' shut line',[(side*breadth(ya)*.89,ya,shoulder(ya)+.005),(side*breadth((ya+yb)/2)*.85,(ya+yb)/2,shoulder((ya+yb)/2)+.01),(side*breadth(yb)*.82,yb,shoulder(yb)+.009)],.0022,M['seam'],body,5)
    for front in (True,False):
        sy=1 if front else -1;y=sy*half
        add(cube('Rounded integrated bumper',(0,y-sy*.08,.50),(breadth(y)*2,.36,.37),M['paint'],.135))
        add(cube('Bumper lower valance',(0,y+sy*.042,.348),(1.60 if not isvan else 1.79,.018,.09),M['seam'],.027))
        fascia=[];faces=[];nx=24;nz=4
        for j in range(nz+1):
            t=j/nz
            for i in range(nx+1):
                a=-1+2*i/nx;x=a*breadth(y)*.962
                top=shoulder(y)+.04*(1-a*a)
                fascia.append((x,y+sy*(.04-.14*abs(a)**4),.58*(1-t)+top*t))
        for j in range(nz):
            for i in range(nx):
                k=j*(nx+1)+i;faces.append((k,k+1,k+nx+2,k+nx+1))
        add(orient_mesh('Closed curved front fascia' if front else 'Closed rear body fascia',fascia,faces,M['paint'],(0,sy,0)))
        for side in (-1,1):add(sphere('Bumper parking sensor',(side*.65,y+sy*.137,.49),(.011,.005,.011),M['seam'],12,6))
    # Cabin body sides are actual surfaces with inset glass and narrow flush
    # pillars. No freestanding cylindrical A-pillars or floating roof edges.
    def upper_y(y):return max(rearroof,min(frontroof,y))
    def sidepoint(side,y,t,offset=0):
        return (side*(w*.952*(1-t)+rw*t+offset),y*(1-t)+upper_y(y)*t,(.892 if not isvan else .971)*(1-t)+(roofz-.035)*t)
    for side in (-1,1):
        intervals=[rearbase,-.89,-.04,frontbase] if not isvan else [rearbase,-.43,frontbase]
        for a,b in zip(intervals,intervals[1:]):
            # Outer window bay is painted; glass overlays inset leaving a solid frame.
            v=[sidepoint(side,a,0),sidepoint(side,b,0),sidepoint(side,b,1),sidepoint(side,a,1)]
            add(orient_mesh('Cabin flush window frame',v,[(0,1,2,3)],M['paint'],(side,0,0),False))
            if isvan and b<=-.43:continue
            # Top and bottom corner adjustment also prevents degenerate slope windows.
            margin=.035 if not isvan else .045
            glassv=[sidepoint(side,a+margin,.075,.004),sidepoint(side,b-margin,.075,.004),sidepoint(side,b-margin,.905,.004),sidepoint(side,a+margin,.905,.004)]
            add(orient_mesh('Inset side tinted glazing',glassv,[(0,1,2,3)],M['carGlass'],(side,0,0),False))
            polyline('Window black perimeter seal',glassv+[glassv[0]],.008,M['seam'],body,6)
        for y in ([-.89,-.04] if not isvan else [-.43]):
            a=y-.025;b=y+.025
            v=[sidepoint(side,a,.055,.01),sidepoint(side,b,.055,.01),sidepoint(side,b,.96,.01),sidepoint(side,a,.96,.01)]
            add(orient_mesh('Satin B C pillar insert',v,[(0,1,2,3)],M['seam'],(side,0,0),False))
        # Door seams curve into the frame, handles are inset with a pull recess.
        doorlimits=[-1.16,-.04,1.14] if not isvan else [-.44,1.34]
        for y in doorlimits:
            polyline('Door pressed panel shut line',[(side*breadth(y)*1.005,y,.40),(side*breadth(y)*1.005,y,.67),(side*breadth(y)*.968,y,.89 if not isvan else .968)],.0025,M['seam'],body,5)
        for y in ([-.38,.86] if not isvan else [.97]):
            add(cube('Door handle recessed pocket',(side*(breadth(y)+.004),y,.829),(.011,.17,.033),M['seam'],.013))
            add(cube('Body colour door handle',(side*(breadth(y)+.015),y+.008,.841),(.025,.135,.020),M['paint'],.009))
        polyline('Body pressed shoulder crease',[(side*breadth(y)*.973,y,.86+.013*math.cos(y)) for y in ys[7:-7:4]],.0025,M['paint'],body,5)
        polyline('Sill rocker trim',[(side*breadth(y)*.995,y,.32) for y in ys[11:-11:5]],.012,M['seam'],body,8)
        add(tube('Side mirror stalk',(side*.85,.91,1.025),(side*(w+.095),.85,1.09),.021,M['seam'],10))
        add(cube('Aerodynamic mirror housing',(side*(w+.135),.85,1.11),(.215,.18,.116),M['paint'],.048))
        add(cube('Mirror reflective glass',(side*(w+.135),.759,1.11),(.166,.008,.074),M['chrome'],.025))
    # Rounded roof edge and windshield, joined by a metal rim rather than poles.
    vs=[];fs=[];ny=15;nx=24
    for j in range(ny+1):
        y=rearroof+(frontroof-rearroof)*j/ny
        ww=rw*(.972+.028*math.sin(math.pi*j/ny))
        for i in range(nx+1):
            t=-1+2*i/nx
            vs.append((ww*t,y,roofz+.041*(1-t*t)-.027*(abs(t)**8)))
    for j in range(ny):
        for i in range(nx):
            k=j*(nx+1)+i;fs.append((k,k+1,k+nx+2,k+nx+1))
    add(orient_mesh('Double curvature metal roof',vs,fs,M['paint'],(0,0,1)))
    for front,base,top in [(True,frontbase,frontroof),(False,rearbase,rearroof)]:
        sy=1 if front else -1;vs=[];fs=[];rows=8;columns=24
        for j in range(rows+1):
            t=j/rows
            for i in range(columns+1):
                a=-1+2*i/columns
                xx=a*(w*.938*(1-t)+rw*.972*t)
                yy=base*(1-t)+top*t+sy*.028*(1-a*a)*math.sin(math.pi*t)
                roofheight=roofz+.041*(1-a*a)-.027*(abs(a)**8)
                zz=((.893 if not isvan else .972)+.006*(1-a*a))*(1-t)+roofheight*t
                vs.append((xx,yy,zz))
        for j in range(rows):
            for i in range(columns):
                k=j*(columns+1)+i;fs.append((k,k+1,k+columns+2,k+columns+1))
        add(orient_mesh('Curved windscreen' if front else 'Curved rear glazing',vs,fs,M['carGlass'],(0,sy,0)))
        for side in (-1,1):
            base_z=.896 if not isvan else .976
            polyline('Flush painted A D pillar',[(side*w*.947,base,base_z),(side*(w*.947+rw)*.5,(base+top)*.5,(base_z+roofz-.027)*.5),(side*rw,top,roofz-.025)],.026,M['paint'],body,10)
        for row in (0,rows):polyline('Glazing rubber gasket',vs[row*(columns+1):(row+1)*(columns+1)],.009,M['seam'],body,6)
    if isvan:
        for side in (-1,1):
            polyline('Cargo sliding door seam',[(side*.945,-.49,.45),(side*.955,-.49,1.03),(side*.873,-.49,2.04),(side*.873,-2.14,2.04),(side*.954,-2.14,.45)],.003,M['seam'],body,6)
            polyline('Cargo sliding rail',[(side*.964,-.55,1.26),(side*.965,-2.18,1.26)],.015,M['seam'],body,8)
            add(cube('Cargo door pull',(side*.969,-.69,1.05),(.022,.18,.037),M['seam'],.012))
        # Closed rear cargo doors instead of a van-sized glass panel.
        add(cube('Cargo rear split doors',(0,-half+.055,1.48),(1.70,.058,1.28),M['paint'],.048))
        polyline('Rear cargo centre seam',[(0,-half-.002,.89),(0,-half-.002,2.09)],.004,M['seam'],body,6)
    # Visible, enclosed interior: contoured seats, driver, belt, dashboard,
    # steering wheel and door liners. All remain behind tinted glazing.
    add(cube('Interior dark floor',(0,-.20,.56),(1.62,3.30,.10),M['carInterior'],.04))
    add(cube('Dashboard moulded fascia',(0,.73 if not isvan else 1.04,.83 if not isvan else .99),(1.53,.36,.14),M['carInterior'],.055))
    for x in (-.39,.39):
        for y in ([.20] if isvan else [-.77,.26]):
            add(cube('Seat sculpted cushion',(x,y,.745),(.43,.46,.14),M['carInterior'],.065))
            seat=add(cube('Seat contoured backrest',(x,y-.19,1.015),(.435,.145,.51),M['carInterior'],.067));seat.rotation_euler.x=-.10
            add(cube('Seat head restraint',(x,y-.22,1.329),(.245,.12,.16),M['carInterior'],.04))
    add(cube('Centre console',(0,.37,.775),(.17,.52,.20),M['carInterior'],.037))
    steerY=.75 if not isvan else .93
    points=[(-.39+.145*math.cos(math.tau*i/28),steerY,1.10+.145*math.sin(math.tau*i/28)) for i in range(29)]
    polyline('Steering wheel leather rim',points,.011,M['seam'],body,7)
    for a in (0,math.pi,math.pi*1.5):polyline('Steering wheel spokes',[(-.39,steerY,1.10),(-.39+.137*math.cos(a),steerY,1.10+.137*math.sin(a))],.014,M['carInterior'],body,8)
    add(sphere('Seated driver head',(-.39,.28,1.345),(.073,.076,.102),M['skin2'],18,10))
    add(sphere('Seated driver hair',(-.39,.265,1.386),(.077,.078,.065),M['hair2'],18,8))
    add(sphere('Seated driver jacket',(-.39,.27,1.104),(.168,.096,.20),M['coat'],18,10))
    for side in (-1,1):polyline('Driver forearm',[(-.39+side*.145,.31,1.17),(-.39+side*.15,.53,1.04),(-.39+side*.117,steerY-.035,1.095)],.035,M['coat'],body,10)
    polyline('Driver shoulder seatbelt',[(-.535,.20,1.286),(-.36,.385,1.08),(-.23,.34,.87)],.013,M['seam'],body,6)
    # Rounded tyres with tread grooves, recessed rims, machined split spokes,
    # brake discs, calipers and five lug bolts. Each wheel keeps its own pivot.
    for side,label in ((-1,'L'),(1,'R')):
        for cy,which in ((wheelbase/2,'F'),(-wheelbase/2,'R')):
            wheel=empty('wheel_'+which+label,(side*w,cy,radius),root)
            wheel['rollingRadius']=radius
            wheel_surface('Rounded tyre sidewall',cy,radius,side,w,[(-.14,radius*.70),(-.14,radius*.90),(-.115,radius*.98),(-.08,radius),(.045,radius),(.072,radius*.97),(.079,radius*.90),(.079,radius*.71)],M['tire'],wheel,48)
            for axial in (-.075,-.025,.025):wheel_surface('Tyre circumferential groove',cy,radius,side,w,[(axial-.003,radius+.0004),(axial+.003,radius+.0004)],M['seam'],wheel,48)
            rim=.71*radius
            wheel_surface('Machined alloy rim',cy,radius,side,w,[(.079,rim),(.086,rim),(.086,rim-.012),(.065,rim-.017),(.035,rim-.017)],M['chrome'],wheel,44)
            add(tube('Brake disc',(side*(w+.039),cy,radius),(side*(w+.048),cy,radius),rim*.83,M['steel'],36),wheel)
            add(tube('Dark recessed hub',(side*(w+.048),cy,radius),(side*(w+.051),cy,radius),rim*.95,M['seam'],40),wheel)
            for j in range(5):
                a=j*math.tau/5
                for split in (-1,1):
                    b=a+split*.10
                    pts=[(side*(w+.073),cy+.040*math.sin(a),radius+.040*math.cos(a)),(side*(w+.076),cy+rim*.94*math.sin(b),radius+rim*.94*math.cos(b))]
                    polyline('Alloy split spoke',pts,.011 if not isvan else .016,M['chrome'],wheel,7)
                add(tube('Wheel lug bolt',(side*(w+.080),cy+.040*math.sin(a),radius+.040*math.cos(a)),(side*(w+.088),cy+.040*math.sin(a),radius+.040*math.cos(a)),.007,M['steel'],8),wheel)
            add(tube('Alloy centre cap',(side*(w+.076),cy,radius),(side*(w+.084),cy,radius),.026,M['steel'],20),wheel)
    # Recessed radiator and separate contemporary lamp clusters, with amber
    # nodes retained independently for hazard light animation.
    frontY=half+.03
    lamp_offset=0 if isvan else -.03
    add(cube('Radiator grille surround',(0,frontY,.769+lamp_offset),(.67,.032,.19),M['chrome'],.047))
    add(cube('Recessed radiator grille',(0,frontY+.019,.769+lamp_offset),(.61,.012,.135),M['seam'],.039))
    for z in (.721,.756,.792):polyline('Grille horizontal blade',[(-.27,frontY+.027,z+lamp_offset),(.27,frontY+.027,z+lamp_offset)],.004,M['chrome'],body,6)
    add(cube('Lower cooling intake',(0,half+.14,.45),(.93,.009,.108),M['seam'],.031))
    for side,label in ((-1,'L'),(1,'R')):
        x=side*.61
        optical_cluster('Headlamp recessed dark housing',side,half,[(.367,.86),(.80,.855),(.84,.795),(.79,.747),(.418,.759)],M['seam'],body,height_offset=lamp_offset)
        optical_cluster('Headlamp fitted smoked glass',side,half,[(.38,.85),(.793,.847),(.829,.795),(.785,.758),(.427,.769)],M['headlampGlass'],body,.003,lamp_offset)
        for dx in (-.075,.075):
            xx=x+dx;yy=half+.068-.088*(abs(xx)/.84)**4
            add(tube('Headlamp chrome reflector',(xx,yy,.806+lamp_offset),(xx,yy+.004,.806+lamp_offset),.031,M['chrome'],20))
            add(tube('Headlamp optical projector',(xx,yy+.005,.806+lamp_offset),(xx,yy+.008,.806+lamp_offset),.023,M['headlight'],20))
        polyline('Headlight running light ribbon',[(side*.435,half+.067,.772+lamp_offset),(side*.775,half+.003,.766+lamp_offset),(side*.812,half-.008,.805+lamp_offset)],.0033,M['headlight'],body,6)
        rear_offset=0 if isvan else -.045
        add(cube('Rear sculpted brake lamp',(side*.651,-half-.052,.802+rear_offset),(.321,.030,.176),M['brake'],.040))
        for z in (.769,.818):polyline('Rear LED lamp ribbon',[(side*.651-.128,-half-.070,z+rear_offset),(side*.651+.128,-half-.070,z+rear_offset)],.0035,M['brake'],body,6)
        add(cube('Reversing optical strip',(side*.651,-half-.074,.785+rear_offset),(.246,.007,.021),M['reversingLens'],.006))
        add(cube('Rear lamp wraparound',(side*(breadth(-half+.07)+.006),-half+.075,.803+rear_offset),(.013,.19,.152),M['brake'],.005))
        for front,which in ((True,'F'),(False,'R')):
            indicator=empty('indicator_'+which+label,parent=body)
            yy=half+.066 if front else -half-.075
            add(cube('Amber indicator lens',(side*(.785 if front else .651),yy,(.813+lamp_offset) if front else (.852+rear_offset)),(.035 if front else .21,.008,.020),M['indicator'],.007),indicator)
    plate='4A6 8322' if kind=='wagon' else '7AE 5194' if ishatch else '3AS 2806'
    for front in (True,False):
        sy=1 if front else -1;yy=sy*(half+.116)
        add(cube('Czech registration plate',(0,yy,.590),(.52,.011,.11),M['plate'],.005))
        add(cube('Registration EU stripe',(-.235,yy+sy*.007,.591),(.035,.004,.095),M['plateBlue'],.001))
        add(text('Czech registration',plate,(0,yy+sy*.009,.591),.047,M['seam'],(math.pi/2,0,math.pi if front else 0)))
    for x in (-.33,.32):
        points=[]
        for t,dx in [(.05,0),(.32,-.14),(.48,-.20)]:
            z0=.896 if not isvan else .976
            points.append((x+dx,frontbase+(frontroof-frontbase)*t+.021,z0+(roofz+.034-z0)*t))
        polyline('Windscreen wiper',points,.0035,M['seam'],body,6)
    if kind=='wagon':
        for side in (-1,1):
            polyline('Roof luggage rail',[(side*.59,-1.25,roofz+.063),(side*.60,-1.05,roofz+.071),(side*.60,.22,roofz+.071),(side*.59,.31,roofz+.062)],.013,M['chrome'],body,9)
    # Rear-view detailing is visible from a tram following traffic.
    polyline('Rear hatch outline',[(-.62,-half-.069,.73),(-.69,rearbase-.035,.97),(0,rearbase-.041,.986),(.69,rearbase-.035,.97),(.62,-half-.069,.73)],.0025,M['seam'],body,6)
    add(tube('Exhaust tailpipe',(.57,-half+.12,.277),(.57,-half-.04,.277),.030,M['steel'],18))
    export(name)
    if not OPTIONS.no_previews:A.preview(name+'_v2_preview',(7,10,4.6),(0,0,.87),1250,800,lens=58)


if __name__=='__main__':
    parser=argparse.ArgumentParser(description='Generate original metre-scale assets without changing unrelated files.')
    parser.add_argument('--models',nargs='+',choices=['tram','car','hatchback','van','pedestrian','pedestrian_2','pedestrian_3','pedestrian_4'])
    parser.add_argument('--no-previews',action='store_true')
    OPTIONS=parser.parse_args(sys.argv[sys.argv.index('--')+1:] if '--' in sys.argv else [])
    if OPTIONS.no_previews:A.preview=lambda *args,**kwargs:None
    selected=OPTIONS.models or ['tram','car','hatchback','van','pedestrian','pedestrian_2','pedestrian_3','pedestrian_4']
    if 'tram' in selected:
        bake_surface_texture(M['floor'],'rubber_floor_grain',(.068,.071,.063),256,.017)
        bake_surface_texture(M['dash'],'worn_cab_enamel',(.115,.185,.205),256,.012)
        create_tram()
    for variant in range(4):
        if ('pedestrian' if variant==0 else 'pedestrian_'+str(variant+1)) in selected:create_person(variant)
    for kind,name in [('wagon','car'),('hatchback','hatchback'),('van','van')]:
        if name in selected:create_vehicle(kind)
    print('DETAILED_ASSETS_COMPLETE',flush=True)
