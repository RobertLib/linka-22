"""Build the Prague Line 22 simulator's original Blender assets.

Run: Blender --background --factory-startup --python scripts/create_assets.py
Units: metres. Blender +Y is the vehicle front, which exports as glTF -Z.
The T3 geometry uses the published DPP dimensions and visual references.
These are original, efficient game models, not CAD or surveyed reproductions.
"""
import bpy
import math
from pathlib import Path
from mathutils import Vector

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "public" / "models"
NATIVE = ROOT / "assets"
OUT.mkdir(parents=True, exist_ok=True)
NATIVE.mkdir(parents=True, exist_ok=True)

def material(name, color, metallic=0, roughness=.5, alpha=1, emission=0):
    m = bpy.data.materials.new(name)
    m.diffuse_color = (*color, alpha)
    m.use_nodes = True
    bs = m.node_tree.nodes.get('Principled BSDF')
    bs.inputs['Base Color'].default_value = (*color, alpha)
    bs.inputs['Metallic'].default_value = metallic
    bs.inputs['Roughness'].default_value = roughness
    bs.inputs['Alpha'].default_value = alpha
    if emission:
        bs.inputs['Emission Color'].default_value = (*color, 1)
        bs.inputs['Emission Strength'].default_value = emission
    if alpha < 1:
        m.surface_render_method = 'DITHERED'
        m.use_transparent_shadow = False
    return m

M = {
    'red': material('DPP vermilion enamel', (.58,.028,.018), .12,.3),
    'cream': material('Tatra warm ivory', (.83,.74,.50), .04,.42),
    'rubber': material('Window seals and rubber', (.022,.026,.027),0,.7),
    'steel': material('Brushed steel', (.26,.29,.30),.72,.29),
    'chrome': material('Chrome trim', (.67,.7,.69),.88,.19),
    'black': material('Chassis graphite', (.06,.068,.073),.35,.6),
    'glass': material('Clear tram glazing', (.73,.85,.87),.04,.12,.045),
    'window': material('Car glazing', (.11,.18,.22),.35,.15),
    'interior': material('Interior cream laminate', (.64,.60,.48),0,.6),
    'floor': material('Dark rubber floor', (.12,.13,.12),0,.8),
    'seat': material('Moulded orange passenger seats', (.81,.20,.04),0,.4),
    'yellow': material('Yellow grab rails', (.99,.66,.04),.1,.34),
    'dash': material('Dashboard worn dark grey green', (.067,.105,.086),.08,.57),
    'white': material('White markings', (.93,.91,.79),0,.45),
    'led': material('Amber LED display', (1,.45,.035),0,.45,1,1.7),
    'headlamp': material('Headlamp lens', (1,.91,.65),.05,.18,1,.8),
    'tail': material('Tail lamp red', (.66,.01,.004),.05,.22,1,.45),
    'blue': material('Blue enamel paint', (.09,.23,.34),.3,.25),
    'stone': material('Bohemian warm sandstone', (.59,.50,.36),0,.84),
    'stucco': material('Ivory historic stucco', (.73,.68,.55),0,.78),
    'copper': material('Oxidised green copper', (.16,.35,.28),.5,.54),
    'gold': material('Gilded rooftop ornament', (.72,.51,.10),.65,.3),
    'roof': material('Dark slate roof', (.13,.15,.16),.16,.73),
    'terracotta': material('Terracotta church roof', (.38,.11,.033),0,.87),
    'landmarkWindow': material('Historic dark window panes',(.028,.041,.045),.12,.34),
    'skin': material('Skin', (.58,.36,.22),0,.7),
    'coat': material('Dark navy coat', (.09,.13,.18),0,.85),
    'pants': material('Blue grey trousers', (.13,.20,.27),0,.8),
    'hair': material('Brown hair', (.095,.054,.032),0,.9),
    'door': material('Moving door surfaces', (1,1,1),.12,.36),
}
door_vertex_color=M['door'].node_tree.nodes.new('ShaderNodeVertexColor')
door_vertex_color.layer_name='DoorColor'
M['door'].node_tree.links.new(door_vertex_color.outputs['Color'],M['door'].node_tree.nodes.get('Principled BSDF').inputs['Base Color'])

def clear():
    bpy.ops.object.select_all(action='SELECT')
    bpy.ops.object.delete(use_global=False)

def mesh(name, verts, faces, mat, smooth=False):
    me = bpy.data.meshes.new(name)
    me.from_pydata(verts, [], faces)
    me.update()
    ob = bpy.data.objects.new(name, me)
    bpy.context.collection.objects.link(ob)
    ob.data.materials.append(mat)
    if smooth:
        for p in me.polygons: p.use_smooth=True
    return ob

def cube(name, loc, dim, mat, bevel=0):
    x,y,z = (d/2 for d in dim)
    vs=[(-x,-y,-z),(x,-y,-z),(x,y,-z),(-x,y,-z),(-x,-y,z),(x,-y,z),(x,y,z),(-x,y,z)]
    ob=mesh(name,vs,[(0,3,2,1),(4,5,6,7),(0,1,5,4),(1,2,6,5),(2,3,7,6),(3,0,4,7)],mat)
    ob.location=loc
    if bevel:
        md=ob.modifiers.new('Soft manufactured edges','BEVEL')
        md.width=bevel; md.segments=2
        bpy.context.view_layer.objects.active=ob
        bpy.ops.object.modifier_apply(modifier=md.name)
        for p in ob.data.polygons: p.use_smooth=True
        md=ob.modifiers.new('Weighted normals','WEIGHTED_NORMAL')
        bpy.ops.object.modifier_apply(modifier=md.name)
    return ob

def tube(name, a, b, r, mat, n=12):
    a,b=Vector(a),Vector(b)
    length=(b-a).length
    vs=[]
    for z in (-length/2,length/2):
        for i in range(n):
            t=2*math.pi*i/n
            vs.append((r*math.cos(t),r*math.sin(t),z))
    fs=[tuple(reversed(range(n))),tuple(range(n,2*n))]
    fs += [(i,(i+1)%n,(i+1)%n+n,i+n) for i in range(n)]
    ob=mesh(name,vs,fs,mat,True)
    ob.location=(a+b)/2
    ob.rotation_euler=Vector((0,0,1)).rotation_difference(b-a).to_euler()
    return ob

def sphere(name, loc, scale, mat, n=20, rings=10):
    vs=[];fs=[]
    for j in range(rings+1):
        theta=math.pi*j/rings
        for i in range(n):
            phi=2*math.pi*i/n
            vs.append((math.sin(theta)*math.cos(phi)*scale[0],math.sin(theta)*math.sin(phi)*scale[1],math.cos(theta)*scale[2]))
    for j in range(rings):
        for i in range(n):
            a=j*n+i;b=j*n+(i+1)%n
            fs.append((a,a+n,b+n,b))
    ob=mesh(name,vs,fs,mat,True);ob.location=loc
    return ob

def text(name, body, loc, size, mat, rotation=(math.pi/2,0,math.pi), align='CENTER'):
    cu=bpy.data.curves.new(name,'FONT');cu.body=body;cu.align_x=align;cu.align_y='CENTER';cu.size=size;cu.extrude=.0005;cu.resolution_u=3
    ob=bpy.data.objects.new(name,cu);bpy.context.collection.objects.link(ob);ob.location=loc;ob.rotation_euler=rotation;cu.materials.append(mat)
    bpy.context.view_layer.objects.active=ob;ob.select_set(True);bpy.ops.object.convert(target='MESH');ob.select_set(False)
    return ob

def join_objects(objects,name,origin=(0,0,0)):
    if not objects: return None
    bpy.ops.object.select_all(action='DESELECT')
    for ob in objects: ob.select_set(True)
    bpy.context.view_layer.objects.active=objects[0]
    bpy.ops.object.join()
    ob=bpy.context.object;ob.name=name
    bpy.context.scene.cursor.location=origin
    bpy.ops.object.origin_set(type='ORIGIN_CURSOR')
    ob.select_set(False)
    return ob

def door_vertex_material(ob):
    # Moving leaves use a single primitive each. Preserve their ivory, red,
    # dark window and metal colours as vertex colours, avoiding 60 draw calls
    # just for doors on each traffic tram.
    colors=ob.data.color_attributes.new(name='DoorColor',type='BYTE_COLOR',domain='CORNER')
    for poly in ob.data.polygons:
        rgba=ob.data.materials[poly.material_index].diffuse_color
        for loop in poly.loop_indices:colors.data[loop].color=rgba
    ob.data.color_attributes.active_color=colors
    ob.data.materials.clear();ob.data.materials.append(M['door'])
    for poly in ob.data.polygons:poly.material_index=0

def optimize(exclude=()):
    groups={}
    for ob in list(bpy.context.scene.objects):
        if ob.type!='MESH' or ob.name in exclude: continue
        if len(ob.data.materials)==1:
            groups.setdefault(ob.data.materials[0].name,[]).append(ob)
    for name,obs in groups.items(): join_objects(obs,name)

def export(name, exclude=()):
    # Reuse vendored CC0 roof scans for the two hero landmarks. Sources and
    # licence live in public/textures/manifest.json; no reference-photo pixels
    # are copied into models. Planar metre UVs keep tile size plausible.
    if name.startswith('landmark_'):
        for key,family in [('roof','roof'),('terracotta','roof-red')]:
            mat=M[key]
            if not any(n.type=='TEX_IMAGE' for n in mat.node_tree.nodes):
                bs=mat.node_tree.nodes.get('Principled BSDF')
                for kind in ('color','normal','roughness'):
                    path=ROOT/'public'/'textures'/(family+'-'+kind+'.jpg')
                    if not path.exists():continue
                    source=bpy.data.images.load(str(path),check_existing=True)
                    if kind!='color':source.colorspace_settings.name='Non-Color'
                    source.scale(512,512)
                    # New generated image owns its pixel buffer. Image.copy()
                    # may lazily reload its original packed2Kfile on export.
                    im=bpy.data.images.new(name+' '+family+' '+kind+' 512px',width=512,height=512)
                    if kind!='color':im.colorspace_settings.name='Non-Color'
                    im.pixels=source.pixels[:]
                    if kind=='color' and family=='roof':
                        # A charcoal/blue slate derivative of the CC0 tile
                        # scan; preserve its physical grain, remove brown tint.
                        import numpy as np
                        pixels=np.array(im.pixels[:],dtype=np.float32).reshape((-1,4))
                        grey=pixels[:,:3]@np.array([.2126,.7152,.0722])
                        pixels[:,0]=grey*.60;pixels[:,1]=grey*.69;pixels[:,2]=grey*.80
                        im.pixels=pixels.ravel()
                    # Write the resized copy so glTF does not silently embed
                    # the original 2K packed JPEG despite im.scale(512,512).
                    derived=ROOT/'public'/'textures'/'original'
                    derived.mkdir(parents=True,exist_ok=True)
                    im.filepath_raw=str(derived/('landmark-'+family+'-'+kind+'.jpg'))
                    im.file_format='JPEG';im.save();im.pack()
                    node=mat.node_tree.nodes.new('ShaderNodeTexImage');node.image=im
                    if kind=='normal':
                        normal=mat.node_tree.nodes.new('ShaderNodeNormalMap');normal.inputs['Strength'].default_value=.55
                        mat.node_tree.links.new(node.outputs['Color'],normal.inputs['Color']);mat.node_tree.links.new(normal.outputs['Normal'],bs.inputs['Normal'])
                    else:mat.node_tree.links.new(node.outputs['Color'],bs.inputs['Base Color' if kind=='color' else 'Roughness'])
        bpy.context.view_layer.update()
        for ob in bpy.context.scene.objects:
            if ob.type!='MESH':continue
            uv=ob.data.uv_layers.new(name='LandmarkUV')
            for poly in ob.data.polygons:
                normal=ob.matrix_world.to_3x3()@poly.normal
                axis=max(range(3),key=lambda i:abs(normal[i]))
                axes=(1,2) if axis==0 else (0,2) if axis==1 else (0,1)
                for li in poly.loop_indices:
                    p=ob.matrix_world@ob.data.vertices[ob.data.loops[li].vertex_index].co
                    uv.data[li].uv=(p[axes[0]]/2,p[axes[1]]/2)
    optimize(exclude)
    bpy.ops.object.select_all(action='DESELECT')
    for ob in bpy.context.scene.objects:
        if ob.type in ('MESH','EMPTY'): ob.select_set(True)
    bpy.ops.wm.save_as_mainfile(filepath=str(NATIVE/(name+'.blend')))
    bpy.ops.export_scene.gltf(filepath=str(OUT/(name+'.glb')),export_format='GLB',use_selection=True,export_yup=True,export_apply=True,export_materials='EXPORT',export_extras=True,export_cameras=False,export_lights=False)
    print('ASSET_DONE',name, (OUT/(name+'.glb')).stat().st_size)

def front_surface(name,z0,z1,mat, ybase=6.70, curve=.35):
    n=24;vs=[]
    for z in (z0,z1):
        for i in range(n+1):
            x=-1.25+2.5*i/n
            y=ybase+curve*math.sqrt(max(0,1-(x/1.25)**2))
            vs.append((x,y,z))
    # Front faces must point outwards (+Y), not towards the driver. The old
    # winding made the red nose invisible outside and a red wall in the cab.
    return mesh(name,vs,[(i+n+1,i+1+n+1,i+1,i) for i in range(n)],mat,True)

def create_tram():
    clear()
    cube('Underframe',(0,0,.69),(2.38,13.6,.24),M['black'],.07)
    cube('Passenger floor',(0,-.15,.94),(2.34,13.65,.13),M['floor'])
    # Full-length body side with real cut-outs for three folding doors.
    doors=[('front',5.05),('middle',.15),('rear',-5.0)]
    spans=[(-6.70,-5.69),(-4.31,-.54),(.84,4.36),(5.74,6.70)]
    for side in (-1,1):
        panels=[(-6.70,6.70)] if side<0 else spans
        for ya,yb in panels:
            cube('Red body panel',(side*1.218,(ya+yb)/2,1.31),(.065,yb-ya,.67),M['red'],.018)
            cube('Ivory waist stripe',(side*1.253,(ya+yb)/2,1.697),(.027,yb-ya,.105),M['cream'])
        cube('Upper side gutter',(side*1.20,0,2.79),(.13,13.45,.18),M['cream'],.04)
        for ya,yb in panels:
            tube('Chrome waist moulding',(side*1.26,max(-6.65,ya),1.75),(side*1.26,min(6.65,yb),1.75),.014,M['chrome'])
    # Window arrangements differ on the door side.
    left_centres=[-5.88,-4.60,-3.31,-2.02,-.73,.56,1.85,3.14,4.43,5.68]
    right_centres=[-6.13,-3.69,-2.42,-1.15,1.45,2.72,3.73,6.14]
    for side,centres in [(-1,left_centres),(1,right_centres)]:
        for i,cy in enumerate(centres):
            width=.91 if abs(cy)>5.8 else 1.08
            x=side*1.222
            cube('Window rubber frame',(x,cy,2.23),(.045,width+.075,.98),M['rubber'],.045)
            cube('Passenger glass',(x+side*.022,cy,2.23),(.012,width,.90),M['glass'],.035)
            # Glazing rubber panel is a border, not a black solid backing.
            bpy.data.objects.remove(bpy.data.objects.get('Window rubber frame'),do_unlink=True) if False else None
            # Thin inner and outer sill and vertical pillars.
            for zz in (1.775,2.685): cube('Window horizontal seal',(x,cy,zz),(.062,width+.06,.037),M['rubber'])
            for yy in (cy-(width+.03)/2,cy+(width+.03)/2):
                cube('Ivory window pillar',(side*1.213,yy,2.23),(.075,.085,.95),M['cream'],.013)
                cube('Window vertical seal',(side*1.256,yy,2.23),(.014,.025,.91),M['rubber'])
            tube('Sliding window division',(side*1.262,cy-width/2,2.48),(side*1.262,cy+width/2,2.48),.012,M['chrome'])
    # Delete solid window frame boxes and keep the actual seal strips, for transparent sightlines.
    for ob in list(bpy.context.scene.objects):
        if ob.name.startswith('Window rubber frame'): bpy.data.objects.remove(ob,do_unlink=True)
    # Four real moving leaves per doorway. The two inner leaves are children
    # of their outer neighbours, so opposite rotations produce a folding pair.
    # After glTF conversion: leaf0 +theta, leaf1 -2theta, leaf3 -theta,
    # leaf2 +2theta around local Y. theta=78 degrees leaves an open doorway.
    door_names=[]
    for dn,cy in doors:
        parent=bpy.data.objects.new('door_'+dn,None)
        bpy.context.collection.objects.link(parent)
        parent.location=(1.25,cy,1.78)
        parent['doorMechanism']='bifold'
        parent['doorWidth']=1.24
        leaves={}
        for j in range(4):
            before=set(bpy.context.scene.objects)
            yy=cy+(j-1.5)*.31
            cube('Door ivory leaf',(1.255,yy,1.81),(.07,.302,1.88),M['cream'],.012)
            cube('Door red lower panel',(1.297,yy,1.30),(.021,.281,.61),M['red'],.01)
            cube('Door dark glazing frame',(1.298,yy,2.24),(.014,.235,.88),M['rubber'],.024)
            cube('Door glazing',(1.307,yy,2.24),(.015,.188,.80),M['window'],.022)
            hinge_y=cy+[-.62,-.31,.31,.62][j]
            tube('Folding door hinge',(1.255,hinge_y,.90),(1.255,hinge_y,2.70),.014,M['steel'],8)
            if j==3:tube('Door grab rail',(1.317,cy+.54,1.12),(1.317,cy+.54,1.78),.018,M['steel'])
            leaf=join_objects(list(set(bpy.context.scene.objects)-before),'door_'+dn+'_leaf'+str(j),(1.25,hinge_y,1.78))
            door_vertex_material(leaf)
            leaf['door']=dn
            leaf['leafIndex']=j
            leaf['openingRotation']=[1,-2,2,-1][j]
            leaf['openingAngle']=math.radians(78)
            leaf['hingeAxis']='Y'
            leaves[j]=leaf
            door_names.append(leaf.name)
        for j in (0,3):
            leaves[j].parent=parent
            leaves[j].location=(0,[-.62,-.31,.31,.62][j],0)
        leaves[1].parent=leaves[0];leaves[1].location=(0,.31,0)
        leaves[2].parent=leaves[3];leaves[2].location=(0,-.31,0)
        cube('Door threshold',(1.05,cy,.87),(.43,1.35,.10),M['steel'])
        cube('Entrance step',(1.18,cy,.63),(.22,1.29,.17),M['black'])
    # Rounded iconic front and rear ends.
    front_surface('Rounded front red nose',.79,1.70,M['red'])
    front_surface('Front ivory belt',1.70,1.79,M['cream'])
    front_surface('Front upper ivory cap',2.65,2.87,M['cream'],6.55,.32)
    for side in (-1,1):
        # Two-part panoramic windscreen, subtly canted and angled.
        x0=side*.04;x1=side*1.13
        verts=[(x0,7.017,1.79),(x1,6.865,1.79),(x1,6.697,2.63),(x0,6.84,2.63)]
        mesh('Curved split windscreen',verts,[(0,1,2,3)],M['glass'])
        for a,b in [(verts[0],verts[1]),(verts[1],verts[2]),(verts[2],verts[3]),(verts[3],verts[0])]:tube('Windscreen rubber',a,b,.029,M['rubber'])
        # Round T3 lamps with a chrome outer rim, inset lens.
        tube('Front lamp chrome',(side*.84,7.009,1.36),(side*.84,7.065,1.36),.145,M['chrome'],24)
        tube('Front lamp lens',(side*.84,7.067,1.36),(side*.84,7.072,1.36),.118,M['headlamp'],24)
        tube('Small red front marker',(side*1.02,6.94,1.57),(side*1.02,6.97,1.57),.035,M['tail'])
        tube('Windscreen wiper',(side*.12,7.028,1.83),(side*.56,6.962,2.20),.007,M['black'])
        tube('Wiper blade',(side*.42,6.99,1.97),(side*.80,6.84,2.32),.010,M['rubber'])
    cube('Central windscreen post',(0,6.942,2.21),(.05,.07,.90),M['cream'],.015)
    cube('Destination board',(0,6.93,2.82),(1.38,.12,.27),M['black'],.025)
    text('Front line number','22',(-.48,7.001,2.82),.205,M['led'])
    text('Front destination','NÁDRAŽÍ HOSTIVAŘ',(.23,7.002,2.824),.074,M['led'])
    text('Fleet number','8322',(0,7.071,1.24),.13,M['cream'])
    cube('Front steel bumper',(0,7.08,.76),(2.36,.18,.14),M['black'],.06)
    tube('Coupler shaft',(0,6.85,.54),(0,7.452,.54),.08,M['steel'])
    cube('Coupler head',(0,7.452,.54),(.28,.20,.17),M['steel'],.035)
    # Rear bulkhead.
    cube('Rear red shell',(0,-6.73,1.28),(2.42,.15,.93),M['red'],.09)
    cube('Rear ivory shell',(0,-6.73,2.29),(2.40,.13,1.05),M['cream'],.08)
    cube('Rear window rubber',(0,-6.805,2.22),(1.59,.03,.84),M['rubber'],.07)
    cube('Rear glass',(0,-6.83,2.22),(1.47,.024,.72),M['glass'],.065)
    for xx in (-.94,.94):
        tube('Rear tail lamp',(xx,-6.81,1.47),(xx,-6.855,1.47),.09,M['tail'],20)
    cube('Rear bumper',(0,-6.85,.75),(2.33,.16,.14),M['black'],.045)
    tube('Rear coupler',(0,-6.75,.54),(0,-7.452,.54),.075,M['steel'])
    cube('Rear coupler head',(0,-7.452,.54),(.28,.20,.17),M['steel'],.03)
    text('Rear fleet number','8322',(0,-6.82,1.28),.13,M['cream'],(math.pi/2,0,0))
    # Closed solid roof shell with caps, curved cross section and a rounded
    # tapered front. Every edge has two incident faces; no open roof seams.
    vs=[];fs=[];n=32
    sections=[(-6.79,1.13,.19),(-6.68,1.25,.30),(6.30,1.25,.30),(6.58,1.24,.27),(6.85,1.10,.12)]
    stride=n+3
    for yy,w,h in sections:
        for i in range(n+1):
            t=math.pi*i/n
            vs.append((-w*math.cos(t),yy,2.76+h*math.sin(t)))
        vs += [(w,yy,2.73),(-w,yy,2.73)]
    for j in range(len(sections)-1):
        for i in range(stride):
            a=j*stride+i;b=j*stride+(i+1)%stride
            fs.append((a,a+stride,b+stride,b))
    fs += [tuple(range(stride)),tuple(reversed(range((len(sections)-1)*stride,len(sections)*stride)))]
    roof=mesh('Closed elliptical Tatra roof',vs,fs,M['cream'],True)
    # Recalculate consistently outside to avoid front/back differences.
    bpy.context.view_layer.objects.active=roof;roof.select_set(True)
    bpy.ops.object.mode_set(mode='EDIT');bpy.ops.mesh.select_all(action='SELECT');bpy.ops.mesh.normals_make_consistent(inside=False);bpy.ops.object.mode_set(mode='OBJECT');roof.select_set(False)
    roof['watertightShell']=True
    for yy in (-4.6,-2.0,.4,3.8):
        cube('Roof ventilation hatch',(0,yy,3.083),(.87,.56,.045),M['cream'],.045)
        for x in (-.31,-.15,0,.15,.31):cube('Vent grille',(x,yy,3.11),(.028,.4,.012),M['black'])
    # Bogies: 1,900 mm wheelbase and 6,400 mm pivot spacing.
    for cy in (-3.2,3.2):
        cube('Bogie frame',(0,cy,.43),(1.87,2.32,.29),M['black'],.05)
        for yy in (cy-.95,cy+.95):
            tube('Axle',(-.89,yy,.35),(.89,yy,.35),.11,M['steel'])
            for side in (-1,1):
                tube('Tram wheel',(side*.66,yy,.35),(side*.83,yy,.35),.35,M['steel'],32)
                tube('Wheel tread',(side*.7,yy,.35),(side*.82,yy,.35),.355,M['black'],32)
                tube('Wheel centre',(side*.831,yy,.35),(side*.84,yy,.35),.18,M['steel'],20)
                cube('Axle box',(side*.86,yy,.39),(.19,.27,.22),M['black'],.035)
        for side in (-1,1):
            cube('Bogie visible side beam',(side*.99,cy,.50),(.13,1.85,.13),M['steel'],.025)
            for yy in (cy-.45,cy+.45):
                for k in range(5):tube('Suspension spring',(side*.95,yy,.37+k*.04),(side*.95,yy,.40+k*.04),.12,M['steel'],12)
    cube('Underslung traction equipment',(0,-.2,.52),(1.35,3.2,.27),M['black'],.08)
    # Diamond pantograph as used on many Prague T3R.P cars.
    py=3.45
    cube('Pantograph mounting frame',(0,py,3.13),(1.3,1.5,.10),M['steel'],.025)
    for xx in (-.45,.45):
        tube('Roof insulator',(xx,py-.55,3.08),(xx,py-.55,3.29),.065,M['interior'])
        for a,b in [((xx,py-.65,3.26),(xx,py,4.02)),((xx,py+.65,3.26),(xx,py,4.02)),((xx,py,4.02),(xx,py-.65,4.8)),((xx,py,4.02),(xx,py+.65,4.8))]:tube('Pantograph diamond',a,b,.031,M['steel'])
        tube('Pantograph spring',(xx,py-.50,3.25),(xx,py+.1,3.57),.046,M['black'])
    for yy in (py-.65,py+.65):tube('Pantograph crossbar',(-.49,yy,4.8),(.49,yy,4.8),.035,M['steel'])
    for xx in (-.45,.45):
        for yy in (py-.65,py+.65):tube('Collector support',(xx,yy,4.8),(xx,py,4.88),.024,M['steel'])
    tube('Contact bow',(-.87,py,4.89),(.87,py,4.89),.038,M['black'])
    for xx in (-.72,.72):tube('Collector horn',(xx,py,4.89),(xx*1.2,py,4.75),.025,M['steel'])
    # Passenger salon.
    for yy in [-5.70,-4.50,-3.30,-2.10,-.9,.3,1.5,2.7,3.9]:
        for xx in (-.84,.80):
            if xx>0 and any(abs(yy-dy)<.70 for _,dy in doors):continue
            cube('Seat pedestal',(xx,yy,1.13),(.16,.22,.40),M['steel'],.028)
            cube('Orange seat cushion',(xx,yy,1.36),(.48,.44,.105),M['seat'],.06)
            seat=cube('Moulded passenger back',(xx,yy-.21,1.69),(.47,.09,.60),M['seat'],.06);seat.rotation_euler[0]=-.12
            tube('Seat grab handle',(xx-.20,yy-.22,1.99),(xx+.2,yy-.22,1.99),.014,M['steel'])
    for yy in (-5,-.1,4.9):
        tube('Vertical passenger pole',(.72,yy,1.01),(.72,yy,2.70),.022,M['yellow'])
    for xx in (-.57,.57):tube('Overhead grab rail',(xx,-6.25,2.62),(xx,4.94,2.62),.022,M['yellow'])
    for yy in (-5.5,-3.7,-1.9,-.1,1.7,3.5):
        for xx in (-.57,.57):
            tube('Hanging grab support',(xx,yy,2.62),(xx,yy,2.43),.014,M['yellow'])
            tube('Hanging handle',(xx-.05,yy,2.40),(xx+.05,yy,2.40),.018,M['black'])
    for yy in (-4.7,-1.3,2.0):cube('Salon ceiling light',(0,yy,2.84),(.16,1.06,.024),M['headlamp'],.014)
    for cy in (1.48,6.15):
        cube('Side destination display',(1.283,cy,2.44),(.033,.86,.22),M['black'],.012)
        text('Side route display','22',(1.31,cy,2.44),.16,M['led'],(math.pi/2,0,math.pi/2))
    # Cab bulkhead, physical console, pedals, hand controls and labelled switch bank.
    cabin_before=set(bpy.context.scene.objects)
    cube('Cab bulkhead lower',(-.39,4.88,1.25),(1.7,.055,.58),M['interior'])
    cube('Cab partition glass',(-.40,4.89,2.18),(1.63,.014,1.05),M['glass'])
    for xx in (-1.23,.41):tube('Cab bulkhead frame',(xx,4.89,1.0),(xx,4.89,2.72),.026,M['steel'])
    cube('Cab partition door',(.79,4.89,1.74),(.69,.022,1.5),M['glass'])
    tube('Partition door handle',(.48,4.85,1.35),(.48,4.85,1.62),.018,M['steel'])
    cube('Driver chair cushion',(-.30,5.39,1.35),(.52,.50,.16),M['black'],.08)
    chair=cube('Driver chair back',(-.30,5.13,1.69),(.51,.14,.64),M['black'],.08);chair.rotation_euler[0]=-.09
    tube('Driver seat pedestal',(-.3,5.4,1.03),(-.3,5.4,1.30),.13,M['steel'])
    cube('Dashboard body',(-.12,6.31,1.35),(1.82,.60,.45),M['dash'],.08)
    dash=cube('Sloped console top',(-.12,6.21,1.60),(1.87,.64,.12),M['dash'],.03);dash.rotation_euler[0]=-.19
    cube('Instrument black bank',(-.25,6.16,1.679),(.75,.26,.022),M['black'],.02)
    for xx in (-.49,-.19):
        tube('Analogue gauge bezel',(xx,6.18,1.696),(xx,6.18,1.710),.112,M['chrome'],32)
        tube('Analogue gauge face',(xx,6.18,1.713),(xx,6.18,1.72),.10,M['black'],32)
        tube('Gauge needle',(xx,6.18,1.725),(xx-.055,6.225,1.725),.003,M['white'],6)
        for j in range(12):
            angle=j*2*math.pi/12
            a=(xx+.085*math.cos(angle),6.18+.085*math.sin(angle),1.723)
            b=(xx+.094*math.cos(angle),6.18+.094*math.sin(angle),1.723)
            tube('Gauge tick',a,b,.0025,M['white'],6)
    cube('Digital speed screen',(.20,6.14,1.69),(.22,.11,.014),M['black'],.01)
    text('Digital speed readout','0',(.20,6.14,1.702),.085,M['led'],(0,0,0))
    for ix in range(5):
        for iy in range(2):
            xx=.43+ix*.075; yy=6.16+iy*.13
            cube('Cab button surround',(xx,yy,1.69),(.051,.048,.017),M['black'],.008)
            cube('Cab illuminated button',(xx,yy,1.705),(.032,.032,.016),M['yellow'] if ix<3 else M['red'],.006)
    tube('Drive controller stem',(-.79,6.05,1.70),(-.79,6.05,1.84),.025,M['steel'])
    sphere('Drive controller handle',(-.79,6.05,1.86),(.057,.057,.07),M['black'],16,8)
    for xx in (-.57,-.25,.02):
        pedal=cube('Driver pedal',(xx,5.91,1.035),(.16,.23,.045),M['rubber'],.014);pedal.rotation_euler[0]=-.30
    cube('Ticket console',(.75,5.97,1.91),(.36,.10,.24),M['black'],.025)
    cube('Ticket console screen',(.75,5.91,1.92),(.28,.014,.16),M['window'])
    cube('Driver sun visor',(-.40,6.78,2.62),(.77,.04,.20),M['dash'],.025)
    # Outside mirror, front right.
    tube('Mirror support',(1.17,6.17,2.49),(1.59,6.45,2.43),.024,M['black'])
    cube('Mirror housing',(1.60,6.46,2.42),(.18,.12,.29),M['black'],.045)
    cube('Mirror reflective face',(1.603,6.387,2.42),(.145,.016,.24),M['chrome'],.025)
    cab_obs=list(set(bpy.context.scene.objects)-cabin_before)
    # Save a standalone cab detail scene as well, while preserving alignment to tram.glb.
    cab_groups={}
    for ob in cab_obs:
        cab_groups.setdefault(ob.data.materials[0].name,[]).append(ob)
    cab_obs=[join_objects(obs,'Cab '+name) for name,obs in cab_groups.items()]
    bpy.ops.object.select_all(action='DESELECT')
    for ob in cab_obs: ob.select_set(True)
    bpy.ops.export_scene.gltf(filepath=str(OUT/'cabin.glb'),export_format='GLB',use_selection=True,export_yup=True,export_apply=True)
    non_cab=[(ob,list(ob.users_collection)) for ob in bpy.context.scene.objects if ob not in cab_obs]
    for ob,collections in non_cab:
        for collection in collections:collection.objects.unlink(ob)
    bpy.ops.wm.save_as_mainfile(filepath=str(NATIVE/'cabin.blend'))
    for ob,collections in non_cab:
        for collection in collections:collection.objects.link(ob)
    export('tram',door_names)
    preview('tram_preview',(15,20,10),(0,0,1.5),1400,850)
    preview('cabin_preview',(-.30,5.35,2.05),(-.15,7.2,1.85),1280,800,lens=25)
    for name in door_names:
        leaf=bpy.data.objects[name]
        leaf.rotation_euler.z=leaf['openingRotation']*leaf['openingAngle']
    preview('doors_open_preview',(9,11,5),(0,2,1.5),1280,800,lens=38)
    for name in door_names:bpy.data.objects[name].rotation_euler.z=0

def preview(name, camera, target, width=1100,height=750,lens=46):
    scene=bpy.context.scene
    # Eevee preview with a lit, clean background, no meshes added to exported asset.
    scene.render.engine='BLENDER_EEVEE'
    scene.world.color=(.4,.4,.4)
    scene.world.use_nodes=True
    bg=scene.world.node_tree.nodes.get('Background');bg.inputs[0].default_value=(.13,.17,.22,1);bg.inputs[1].default_value=.5
    bpy.ops.object.light_add(type='AREA',location=(4,5,12));key=bpy.context.object;key.name='Preview key';key.data.energy=2400;key.data.shape='DISK';key.data.size=12
    bpy.ops.object.light_add(type='AREA',location=(-7,-2,8));fill=bpy.context.object;fill.name='Preview fill';fill.data.energy=1600;fill.data.size=10
    bpy.ops.object.light_add(type='SUN',location=(5,-8,20));sun=bpy.context.object;sun.name='Preview sun';sun.data.energy=2.0;sun.rotation_euler=(.5,-.5,-.4)
    bpy.ops.object.camera_add(location=camera);cam=bpy.context.object;cam.name='Preview camera';cam.rotation_euler=(Vector(target)-cam.location).to_track_quat('-Z','Y').to_euler();cam.data.lens=lens;scene.camera=cam
    scene.render.resolution_x=width;scene.render.resolution_y=height;scene.render.resolution_percentage=100
    scene.render.image_settings.file_format='PNG';scene.render.filepath=str(NATIVE/(name+'.png'))
    scene.view_settings.view_transform='AgX'
    bpy.ops.render.render(write_still=True)
    for ob in (key,fill,cam,sun):bpy.data.objects.remove(ob,do_unlink=True)

def create_car():
    clear()
    cube('Compact sedan body',(0,0,.71),(1.77,4.37,.48),M['blue'],.18)
    cube('Front bonnet',(0,1.48,.97),(1.63,1.32,.13),M['blue'],.08)
    # Sloped five-window cabin.
    verts=[(-.79,-1.05,.92),(.79,-1.05,.92),(.77,1.0,.92),(-.77,1.0,.92),(-.64,-.79,1.51),(.64,-.79,1.51),(.61,.42,1.51),(-.61,.42,1.51)]
    mesh('Car cabin glass',verts,[(0,1,5,4),(1,2,6,5),(2,3,7,6),(3,0,4,7)],M['window'])
    cube('Car roof',(0,-.19,1.54),(1.30,1.27,.07),M['blue'],.07)
    for a,b in [(verts[0],verts[4]),(verts[1],verts[5]),(verts[2],verts[6]),(verts[3],verts[7])]:tube('Cabin pillar',a,b,.045,M['blue'])
    for side in (-1,1):
        tube('Side middle pillar',(side*.79,-.20,.93),(side*.65,-.20,1.52),.036,M['blue'])
        for yy in (-.71,.53):cube('Door handle',(side*.897,yy,.86),(.025,.17,.028),M['chrome'],.01)
        cube('Mirror housing',(side*.96,.61,1.18),(.20,.20,.11),M['blue'],.04)
        for yy in (-1.38,1.38):
            tube('Car tyre',(side*.75,yy,.34),(side*.93,yy,.34),.34,M['rubber'],24)
            tube('Alloy wheel',(side*.94,yy,.34),(side*.946,yy,.34),.235,M['chrome'],24)
            tube('Wheel hub',(side*.95,yy,.34),(side*.956,yy,.34),.072,M['black'],12)
            for j in range(5):
                t=j*math.pi*2/5
                tube('Alloy spoke',(side*.958,yy,.34),(side*.958,yy+.19*math.cos(t),.34+.19*math.sin(t)),.019,M['steel'],6)
    cube('Front grille',(0,2.197,.72),(.73,.02,.24),M['black'],.035)
    for xx in (-.52,-.32,-.12,.12,.32,.52):cube('Grille chrome bar',(xx,2.217,.73),(.023,.02,.15),M['chrome'])
    for side in (-1,1):
        cube('Front LED lamp',(side*.62,2.179,.88),(.48,.045,.17),M['headlamp'],.05)
        cube('Rear red lamp',(side*.62,-2.183,.85),(.42,.045,.19),M['tail'],.04)
    for yy in (-2.202,2.224):cube('Registration plate',(0,yy,.63),(.42,.015,.085),M['white'],.008)
    cube('Rear boot',(0,-1.67,.97),(1.62,.85,.12),M['blue'],.07)
    export('car')

def create_pedestrian():
    clear()
    for side in (-1,1):
        tube('Trouser leg',(side*.10,0,.85),(side*.12,.025,.13),.084,M['pants'],12)
        sphere('Shoe',(side*.12,.064,.07),(.10,.18,.068),M['black'],16,8)
        tube('Coat sleeve',(side*.23,0,1.40),(side*.32,.005,.94),.071,M['coat'],12)
        sphere('Hand',(side*.32,.003,.91),(.055,.058,.08),M['skin'],16,8)
    sphere('Coat torso',(0,0,1.17),(.24,.14,.37),M['coat'],20,12)
    tube('Neck',(0,0,1.45),(0,0,1.55),.064,M['skin'],16)
    sphere('Head',(0,0,1.66),(.103,.10,.135),M['skin'],20,12)
    sphere('Hair cap',(0,-.012,1.73),(.108,.10,.074),M['hair'],20,10)
    sphere('Nose',(0,.101,1.653),(.019,.025,.025),M['skin'],12,6)
    for xx in (-.034,.034):sphere('Eye',(xx,.095,1.687),(.007,.005,.005),M['black'],8,4)
    export('pedestrian')

def create_lamp():
    clear()
    tube('Lamp base',(0,0,0),(0,0,.37),.20,M['black'],20)
    tube('Lamp decorated plinth',(0,0,.35),(0,0,.85),.11,M['black'],16)
    tube('Lamp column',(0,0,.82),(0,0,5.57),.064,M['black'],16)
    for z in (.87,1.05,4.60,5.35):tube('Decorative bronze band',(0,0,z),(0,0,z+.05),.095,M['gold'],16)
    for side in (-1,1):
        tube('Ornate arm',(0,0,4.95),(side*.60,0,5.50),.043,M['black'])
        tube('Ornate arm',(side*.60,0,5.50),(side*.9,0,5.47),.043,M['black'])
        cube('Lantern luminous glass',(side*.90,0,5.54),(.30,.30,.47),M['headlamp'],.035)
        cube('Lantern cap',(side*.90,0,5.80),(.43,.43,.10),M['black'],.03)
        cube('Lantern foot',(side*.90,0,5.28),(.34,.34,.10),M['black'],.025)
        for dx in (-.15,.15):
            for dy in (-.15,.15):tube('Lantern vertical frame',(side*.90+dx,dy,5.29),(side*.90+dx,dy,5.78),.018,M['black'],8)
        sphere('Lantern top finial',(side*.90,0,5.90),(.055,.055,.09),M['black'],12,6)
    export('lamp')

def create_shelter():
    clear()
    for xx in (-1.7,1.7):
        for yy in (-.61,.61):tube('Shelter column',(xx,yy,0),(xx,yy,2.49),.05,M['steel'],10)
    cube('Shelter floating roof',(0,0,2.52),(3.75,1.65,.15),M['roof'],.05)
    cube('Shelter ivory roof trim',(0,.84,2.50),(3.74,.05,.13),M['white'])
    cube('Shelter back glass',(0,-.62,1.35),(3.36,.017,2.25),M['glass'])
    for xx in (-1.71,1.71):cube('Shelter side glass',(xx,-.12,1.35),(.017,1.0,2.25),M['glass'])
    for xx in (-.76,0,.76):tube('Bench support',(xx,-.26,.05),(xx,-.26,.44),.044,M['steel'])
    cube('Shelter bench',(0,-.28,.48),(2.83,.35,.085),M['interior'],.035)
    cube('Shelter bench back',(0,-.47,.72),(2.83,.055,.35),M['interior'],.025)
    tube('Stop post',(2.45,.55,0),(2.45,.55,3.10),.045,M['red'],12)
    cube('Prague tram stop sign',(2.45,.55,2.91),(.60,.055,.72),M['red'],.025)
    cube('Stop white centre',(2.45,.585,2.91),(.52,.02,.64),M['white'],.02)
    text('Stop tram pictogram','T',(2.45,.602,3.03),.28,M['red'])
    text('Stop route number','22',(2.45,.603,2.77),.16,M['black'])
    cube('Timetable case',(2.45,.55,1.66),(.49,.09,.84),M['steel'],.015)
    cube('Timetable white sheet',(2.45,.602,1.66),(.43,.012,.76),M['white'])
    for j in range(12):cube('Timetable printed line',(2.45,.611,1.99-j*.057),(.31,.003,.008),M['black'])
    export('shelter')

def arch(name,x,y,z,width,height,depth,mat):
    # Window recess with an upper semicircle, facade faces towards -Y.
    n=12;vs=[(x-width/2,y,z),(x+width/2,y,z)]
    for i in range(n+1):
        t=i*math.pi/n
        vs.append((x+width/2*math.cos(t),y,z+height-width/2+width/2*math.sin(t)))
    ob=mesh(name,vs,[tuple(range(len(vs)))],mat)
    for i in range(2,len(vs)-1):tube('Arch stone trim',vs[i],vs[i+1],depth,M['stone'],8)
    tube('Arch left pilaster',(x-width/2,y,z),(x-width/2,y,z+height-width/2),depth,M['stone'],8)
    tube('Arch right pilaster',(x+width/2,y,z),(x+width/2,y,z+height-width/2),depth,M['stone'],8)
    return ob

def create_narodni():
    clear()
    # Recognisable original interpretation of Josef Zitek's Neo-Renaissance theatre.
    cube('Theatre masonry block',(0,0,12.1),(37,48,23.0),M['stone'],.18)
    cube('Theatre upper stucco',(0,0,18.1),(37.2,48.2,11.0),M['stucco'],.12)
    for z in (.4,3.2,9.2,10,18.2,22.9,24.0):
        cube('Front projecting cornice',(0,-24.4,z),(38.4,.85,.34),M['stone'],.05)
        cube('Side projecting cornice',(18.75,0,z),(.62,48.8,.34),M['stone'],.05)
        cube('Side projecting cornice',(-18.75,0,z),(.62,48.8,.34),M['stone'],.05)
    # Rich river and street facades.
    for x in [-15,-10,-5,0,5,10,15]:
        arch('Ground arcade',x,-24.49,.8,3.2,6.9,.17,M['window'])
        arch('Tall theatre window',x,-24.49,10.2,2.4,6.9,.14,M['window'])
        cube('Upper theatre window',(x,-24.5,20.2),(1.70,.035,2.4),M['window'])
        cube('Window upper pediment',(x,-24.68,21.62),(2.30,.35,.31),M['stone'],.035)
        for dx in (-1.9,1.9):
            tube('Corinthian theatre column',(x+dx,-24.76,10.2),(x+dx,-24.76,18.1),.31,M['stone'],14)
            cube('Column capital',(x+dx,-24.76,18.03),(.90,.77,.31),M['stone'],.04)
    for side in (-1,1):
        for yy in [-20,-15,-10,-5,0,5,10,15,20]:
            cube('Side tall window',(side*18.61,yy,13.45),(.024,2.2,5.5),M['window'])
            cube('Side upper window',(side*18.62,yy,20.3),(.025,1.5,2.3),M['window'])
            for dy in (-1.62,1.62):tube('Side facade column',(side*18.79,yy+dy,10.1),(side*18.79,yy+dy,18.1),.25,M['stone'],12)
    # The actual vaulted roof is dark slate; gold belongs to the perimeter
    # crown, not its entire surface (ND's official exterior photographs).
    vs=[];n=20
    for yy in (-23.5,23.5):
        for i in range(n+1):
            xx=-18.3+36.6*i/n
            zz=24.1+7.2*math.sqrt(max(0,1-(xx/18.3)**2))
            vs.append((xx,yy,zz))
    roof_faces=[(i,i+1,n+2+i,n+1+i) for i in range(n)]
    roof_faces += [tuple(reversed(range(n+1))),tuple(range(n+1,2*(n+1)))]
    mesh('Theatre closed slate vaulted roof',vs,roof_faces,M['roof'],True)
    for yy in (-23.5,23.5):
        for i in range(n):
            a=vs[i];b=vs[i+1]
            tube('Gold roof end edging',(a[0],yy,a[2]),(b[0],yy,b[2]),.045,M['gold'],8)
    # Gilded wrought-iron crown follows the upper ridge. Original simplified
    # asset had duplicated ribs on one end and no longitudinal crown.
    for xx in (-2.0,2.0):
        tube('Gold crown horizontal rail',(xx,-22,31.5),(xx,22,31.5),.035,M['gold'],8)
        for yy in range(-22,23,2):
            tube('Gold crown finial',(xx,yy,31.18),(xx,yy,32.05),.023,M['gold'],8)
            sphere('Crown ornament',(xx,yy,31.76),(.12,.12,.15),M['gold'],12,8)
    for yy in (-24,24):
        for xx in range(-17,18,2):
            tube('Balustrade',(xx,yy,23.8),(xx,yy,25.35),.12,M['stone'],10)
        cube('Balustrade coping',(0,yy,25.35),(37.5,.45,.28),M['stone'],.045)
    # ND has trigy (three horses), not quadrigae (four). The sculptures remain
    # original game silhouettes; horse count follows ND's official gallery.
    triga_before=set(bpy.context.scene.objects)
    for side in (-1,1):
        sx=side*15
        cube('Triga pedestal',(sx,-21.0,25.8),(3.7,4.3,.8),M['stone'],.05)
        for dx in (-.80,0,.80):
            sphere('Bronze horse body',(sx+dx,-22.0,27.1),(.31,1.12,.55),M['copper'],16,8)
            tube('Horse neck',(sx+dx,-22.66,27.13),(sx+dx,-23.01,28.2),.16,M['copper'])
            sphere('Horse head',(sx+dx,-23.14,28.2),(.18,.35,.19),M['copper'],12,6)
            for dy in (-.60,.62):tube('Horse leg',(sx+dx,-22.0+dy,26.3),(sx+dx,-22.0+dy,27.0),.07,M['copper'])
        tube('Victory statue',(sx,-19.8,26.4),(sx,-19.8,29.0),.19,M['copper'])
        sphere('Victory head',(sx,-19.8,29.3),(.26,.26,.31),M['copper'],16,8)
        tube('Raised victory arm',(sx,-19.8,28.6),(sx+.9,-19.8,30.2),.08,M['copper'])
    # Place them on the projecting north-front terrace; the old position
    # buried almost all horses behind the tall solid roof end cap.
    for ob in set(bpy.context.scene.objects)-triga_before:ob.location.y-=5.0
    text('Theatre inscription','NÁROD SOBĚ',(0,-24.8,23.2),.87,M['gold'],(math.pi/2,0,0))
    export('landmark_narodni')
    preview('narodni_preview',(70,-90,63),(0,0,15))

def lathe(name, profile, mat, n=48):
    vs=[]
    for r,z in profile:
        for i in range(n):
            t=i*2*math.pi/n;vs.append((r*math.cos(t),r*math.sin(t),z))
    fs=[]
    for j in range(len(profile)-1):
        for i in range(n):fs.append((j*n+i,j*n+(i+1)%n,(j+1)*n+(i+1)%n,(j+1)*n+i))
    return mesh(name,vs,fs,mat,True)

def create_mikulas():
    clear()
    cube('Baroque church nave',(0,0,13),(26,44,26),M['stucco'],.16)
    cube('Church stone base',(0,0,1.4),(27,45,2.8),M['stone'],.08)
    # West facade with paired pilasters and curved pediment.
    for x in (-11,-7,-3,3,7,11):
        tube('Baroque facade pilaster',(x,-22.3,2.9),(x,-22.3,24.5),.45,M['stone'],12)
        cube('Baroque column capital',(x,-22.3,24.6),(1.4,1.1,.55),M['stone'],.08)
    for z in (3.0,13.0,25.0):cube('Baroque facade cornice',(0,-22.7,z),(27.9,1.1,.65),M['stone'],.10)
    arch('Church main portal',0,-22.73,2.2,4.7,9.1,.25,M['window'])
    for x in (-7.2,7.2):arch('Church tall facade window',x,-22.71,14.1,3.1,8.5,.18,M['window'])
    arch('Church central upper window',0,-22.72,15.1,3.2,7.0,.18,M['window'])
    for side in (-1,1):
        for yy in (-15,-5,5,15):
            x=side*13.08
            vs=[(x,yy-1.55,11.7),(x,yy+1.55,11.7)]
            for j in range(13):
                a=j*math.pi/12
                vs.append((x,yy+1.55*math.cos(a),20.0+1.55*math.sin(a)))
            mesh('Church side arched window',vs,[tuple(range(len(vs)))],M['window'])
            for j in range(2,len(vs)-1):tube('Side window arch trim',vs[j],vs[j+1],.14,M['stone'],8)
            for dy in (-3.6,3.6):
                tube('Side church pilaster',(side*13.2,yy+dy,3.2),(side*13.2,yy+dy,24.8),.28,M['stone'])
        for z in (3.0,13.0,25.0):cube('Church side cornice',(side*13.4,0,z),(.65,44.8,.46),M['stone'],.05)
    mesh('Baroque facade pediment',[(-13,-22.8,25.4),(13,-22.8,25.4),(8,-22.8,29.2),(0,-22.8,32.0),(-8,-22.8,29.2)],[(0,1,2,3,4)],M['stucco'])
    for xx in (-9,0,9):
        tube('Facade statue',(xx,-22.9,26.6),(xx,-22.9,28.6),.23,M['stone'])
        sphere('Facade statue head',(xx,-22.9,28.85),(.27,.26,.29),M['stone'],16,8)
    # The nave roof is ceramic red tile; only dome/tower coverings are copper.
    mesh('Nave terracotta roof',[(-13,-21,26),(13,-21,26),(13,21,26),(-13,21,26),(0,-21,33),(0,21,33)],[(0,1,4),(3,5,2),(0,4,5,3),(1,2,5,4)],M['terracotta'])
    # Monumental high drum and green dome over the crossing.
    dome_before=set(bpy.context.scene.objects)
    dome_y=9
    drum=lathe('Dome masonry drum',[(8.4,25),(8.4,32),(7.7,32.5),(7.7,38),(8.8,38.4),(8.8,39)],M['stucco']);drum.location.y=dome_y
    for i in range(12):
        a=i*math.pi*2/12
        x,y=8.38*math.cos(a),dome_y+8.38*math.sin(a)
        tube('Dome drum pilaster',(x,y,32.4),(x,y,38.2),.29,M['stone'],12)
        x,y=8.42*math.cos(a+.15),dome_y+8.42*math.sin(a+.15)
        sphere('Drum dark window',(x,y,35.2),(.95,.95,1.65),M['window'],20,12)
    profile=[(8.8,39),(8.75,39.6),(8.3,41.5),(7.4,44.2),(6.15,46.7),(4.7,48.9),(3.0,50.4),(1.62,51.2),(1.58,54.2),(2.10,54.4),(1.82,55.6),(1.1,57.1),(.40,58.0),(.14,58.4)]
    ob=lathe('St Nicholas copper dome',profile,M['copper'],64);ob.location.y=dome_y
    for i in range(12):
        a=i*2*math.pi/12
        for j in range(len(profile)-1):
            r,z=profile[j];r2,z2=profile[j+1]
            tube('Dome vertical ribs',(r*math.cos(a),dome_y+r*math.sin(a),z),(r2*math.cos(a),dome_y+r2*math.sin(a),z2),.075,M['copper'],6)
    tube('Dome gold cross stem',(0,dome_y,58.3),(0,dome_y,61.1),.085,M['gold'])
    tube('Dome gold cross arm',(-.7,dome_y,60.2),(.7,dome_y,60.2),.07,M['gold'])
    dome_objects=set(bpy.context.scene.objects)-dome_before
    # Adjacent tall bell tower with bulbous green copper cupola.
    tower_before=set(bpy.context.scene.objects)
    # Rear/south-east of the church, matching the separate OSM bell-tower
    # footprint after world yaw -PI/2. Front of this church is Blender -Y.
    tx=-17.02;ty=39.94
    cube('Bell tower masonry',(tx,ty,32.5),(8.7,9.0,65),M['stucco'],.10)
    for z in (3,14,28,43,47,60,65):cube('Tower cornice',(tx,ty,z),(9.8,10.0,.55),M['stone'],.07)
    for dx in (-3.7,3.7):
        tube('Tower pilaster',(tx+dx,ty-4.7,3),(tx+dx,ty-4.7,59.5),.28,M['stone'],12)
    arch('Bell tower upper opening',tx,ty-4.65,48,3.4,10.8,.18,M['window'])
    # Clock dial faces town square.
    tube('Clock rim',(tx,ty-4.72,62.7),(tx,ty-4.78,62.7),2.0,M['gold'],48)
    tube('Clock black dial',(tx,ty-4.79,62.7),(tx,ty-4.80,62.7),1.84,M['black'],48)
    tube('Clock minute hand',(tx,ty-4.83,62.7),(tx+.20,ty-4.83,64.25),.045,M['gold'])
    tube('Clock hour hand',(tx,ty-4.84,62.7),(tx-1.12,ty-4.84,62.95),.065,M['gold'])
    for j in range(12):
        a=2*math.pi*j/12
        tube('Clock hour tick',(tx+1.6*math.cos(a),ty-4.84,62.7+1.6*math.sin(a)),(tx+1.76*math.cos(a),ty-4.84,62.7+1.76*math.sin(a)),.035,M['gold'],6)
    ob=lathe('Bell tower onion cupola',[(5.3,65),(5.4,66),(4.5,67),(3.8,68),(3.6,70),(2.5,73),(1.4,75.2),(1.3,76),(1.75,76.3),(1.1,77.2),(.25,77.6)],M['copper'],64);ob.location=(tx,ty,0)
    tube('Tower cross stem',(tx,ty,77.5),(tx,ty,79.0),.085,M['gold'])
    tube('Tower cross arm',(tx-.8,ty,78.4),(tx+.8,ty,78.4),.075,M['gold'])
    tower_objects=set(bpy.context.scene.objects)-tower_before
    bpy.context.view_layer.update()
    # Published dimensions: nave 30m, church length60m; domed drum diameter
    #20m, copper dome70m and lantern79m. Map the old profile continuously
    # instead of scaling the whole building and widening the bell tower.
    vertical=[(25,34.6),(32,44),(32.5,44.5),(38,58.8),(38.4,59.4),(39,60),(50.4,69),(51.2,70),(54.2,75),(55.6,76.2),(58.4,77.5),(61.1,79)]
    def dome_height(z):
        for (a,b),(c,d) in zip(vertical,vertical[1:]):
            if z<=c:return b+(z-a)/(c-a)*(d-b)
        return 79+(z-61.1)
    for ob in list(bpy.context.scene.objects):
        if ob.type!='MESH' or ob in tower_objects:continue
        inverse=ob.matrix_world.inverted()
        for v in ob.data.vertices:
            p=ob.matrix_world@v.co
            if ob in dome_objects:
                p.x*=10/8.8;p.y=18+(p.y-dome_y)*10/8.8;p.z=dome_height(p.z)
            else:p.x*=30/26;p.y=p.y*60/44+5;p.z*=36/26
            v.co=inverse@p
    # Replace the old stretched cone with the shallow copper cupola and its
    # separate pale masonry lantern visible in the official reference photo.
    for ob in list(bpy.context.scene.objects):
        if ob.name.startswith(('St Nicholas copper dome','Dome vertical ribs','Drum dark window')):
            bpy.data.objects.remove(ob,do_unlink=True)
    def radial_arch(name,angle,radius,z,width,height,center_y=18):
        tangent=Vector((-math.sin(angle),math.cos(angle),0))
        radial=Vector((math.cos(angle),math.sin(angle),0))
        shape=[(-width/2,z),(width/2,z)]
        for i in range(25):
            a=i*math.pi/24
            shape.append((width/2*math.cos(a),z+height-width/2+width/2*math.sin(a)))
        vs=[]
        for u,h in shape:
            p=radial*radius+tangent*u;p.y+=center_y;p.z=h;vs.append(tuple(p))
        mesh(name,vs,[tuple(range(len(vs)))],M['landmarkWindow'])
        for i in range(len(vs)):
            tube('Baroque radial window stone trim',vs[i],vs[(i+1)%len(vs)],.075,M['stone'],8)
        for u in (0,):
            p=radial*(radius+.012)+tangent*u;p.y+=center_y
            tube('Baroque window vertical mullion',(p.x,p.y,z+.12),(p.x,p.y,z+height-.12),.018,M['steel'],8)
        for h in (z+height*.33,z+height*.66):
            p=radial*(radius+.014);p.y+=center_y
            a=p-tangent*(width/2-.08);b=p+tangent*(width/2-.08)
            tube('Baroque window horizontal mullion',(a.x,a.y,h),(b.x,b.y,h),.018,M['steel'],8)
    for i in range(12):radial_arch('Dome tall arched window',i*math.tau/12+.15,8.78,45,2.0,10.1)
    dome_profile=[(10,60),(9.98,60.7),(9.65,62.5),(8.75,64.8),(7.2,67),(5.35,68.6),(3.0,70)]
    ob=lathe('St Nicholas shallow copper cupola',dome_profile,M['copper'],96);ob.location.y=18
    for i in range(12):
        a=i*math.tau/12
        for (r,z),(r1,z1) in zip(dome_profile,dome_profile[1:]):
            tube('Copper cupola seam',(r*math.cos(a),18+r*math.sin(a),z),(r1*math.cos(a),18+r1*math.sin(a),z1),.038,M['copper'],8)
    ob=lathe('Dome masonry lantern',[(2.7,70),(2.7,74.85),(3.0,75)],M['stucco'],64);ob.location.y=18
    for i in range(8):
        a=i*math.tau/8
        radial_arch('Lantern arched opening',a,2.72,71,.80,3.3)
    ob=lathe('Dome lantern copper cap',[(3.25,75),(3.0,75.4),(2.5,76.1),(1.8,76.8),(.75,77.5),(.10,77.7)],M['copper'],64);ob.location.y=18
    # Side chapels make the full church40m wide, while preserving the 30m
    # main nave. Their exterior detail is still an original approximation.
    for side in (-1,1):
        cube('Rear side chapel',(side*17.5,22,15),(5,18,30),M['stucco'],.12)
        cube('Chapel stone cornice',(side*17.5,22,30),(5.6,18.6,.45),M['stone'],.06)
        mesh('Chapel terracotta roof',[(side*15,13,30),(side*20,13,30),(side*20,31,30),(side*15,31,30),(side*17.5,13,34),(side*17.5,31,34)],[(0,1,4),(3,5,2),(0,4,5,3),(1,2,5,4)],M['terracotta'])
    # The bell tower has dials/openings on all four sides. A one-sided
    # clock disappears from the actual tram-facing (eastern) viewpoint.
    from mathutils import Matrix
    bpy.context.view_layer.update()
    facade=[o for o in tower_objects if o.name.startswith(('Clock','Tower pilaster','Bell tower upper opening','Arch stone trim','Arch left pilaster','Arch right pilaster'))]
    for q in range(1,4):
        transform=Matrix.Translation((tx,ty,0))@Matrix.Rotation(q*math.pi/2,4,'Z')@Matrix.Translation((-tx,-ty,0))
        for original in facade:
            copy=original.copy();copy.data=original.data.copy();bpy.context.collection.objects.link(copy)
            copy.matrix_world=transform@original.matrix_world
    export('landmark_mikulas')
    preview('mikulas_v2_preview',(100,-135,95),(0,9,37),1400,1050,lens=46)
    preview('mikulas_east_v2_preview',(-100,120,80),(0,12,37),1400,1050,lens=46)

if __name__=='__main__':
    create_tram()
    create_car()
    create_pedestrian()
    create_lamp()
    create_shelter()
    create_narodni()
    create_mikulas()
    print('ALL_ASSETS_COMPLETE')
