"""Fetch the CC0 source model and optimize it with Blender (two invocations)."""
from pathlib import Path
import json
import hashlib
import urllib.request
import sys

ROOT = Path(__file__).resolve().parents[1]
SOURCE = Path('/private/tmp/prague22-tree-source')
SOURCE.mkdir(exist_ok=True)

if '--blender' not in sys.argv:
    from concurrent.futures import ThreadPoolExecutor
    def fetch(url):
        request = urllib.request.Request(url, headers={'User-Agent':'PragueLine22 local simulator development'})
        with urllib.request.urlopen(request, timeout=90) as response:
            return response.read()
    metadata = json.loads(fetch('https://api.polyhaven.com/files/tree_small_02'))['gltf']['1k']['gltf']
    files = [('tree_small_02.gltf', metadata)] + list(metadata['include'].items())
    def download(job):
        relative, item = job
        target = SOURCE / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        if target.exists() and hashlib.md5(target.read_bytes()).hexdigest() == item['md5']:
            return
        content = fetch(item['url'])
        if hashlib.md5(content).hexdigest() != item['md5']:
            raise ValueError('Checksum mismatch: ' + relative)
        target.write_bytes(content)
        print(relative, len(content), flush=True)
    with ThreadPoolExecutor(max_workers=3) as executor:
        list(executor.map(download, files))
    print('Source ready for Blender.')
else:
    import bpy
    import math
    from mathutils import Vector
    bpy.ops.object.select_all(action='SELECT')
    bpy.ops.object.delete(use_global=False)
    bpy.ops.import_scene.gltf(filepath=str(SOURCE / 'tree_small_02.gltf'))
    # Split materials to allocate the silhouette budget to the leafy canopy.
    objects = [o for o in bpy.context.scene.objects if o.type == 'MESH']
    for obj in objects:
        bpy.ops.object.select_all(action='DESELECT')
        obj.select_set(True)
        bpy.context.view_layer.objects.active=obj
        bpy.ops.mesh.separate(type='MATERIAL')
    for obj in [o for o in bpy.context.scene.objects if o.type == 'MESH']:
        bpy.context.view_layer.objects.active=obj
        material=obj.data.materials[0].name.lower() if obj.data.materials else ''
        budget = 5000 if 'branch' in material else 3000
        polygons=len(obj.data.polygons)
        if 'leaves' in material:
            # Collapse decimation shrinks disconnected leaves into invisible
            # specks. Planar dissolution keeps each complete leaf silhouette.
            modifier=obj.modifiers.new('Preserve leaf outlines','DECIMATE')
            modifier.decimate_type='DISSOLVE'
            modifier.angle_limit=math.radians(30)
            modifier.use_dissolve_boundaries=True
            modifier.delimit={'UV'}
            bpy.ops.object.modifier_apply(modifier=modifier.name)
        elif polygons>budget:
            modifier=obj.modifiers.new('Realtime silhouette budget','DECIMATE')
            modifier.ratio=budget/polygons
            modifier.use_collapse_triangulate=True
            bpy.ops.object.modifier_apply(modifier=modifier.name)
        obj.name='Tree leaves' if 'leaves' in material else 'Tree branches' if 'branch' in material else 'Tree trunk'
    for image in bpy.data.images:
        if image.source=='FILE': image.pack()
    bpy.ops.wm.save_as_mainfile(filepath=str(ROOT / 'assets' / 'tree_cc0.blend'))
    bpy.ops.export_scene.gltf(filepath=str(ROOT / 'public' / 'models' / 'tree.glb'),export_format='GLB',export_apply=True,export_yup=True)
    # A transparent render of this same tree is the distant LOD, so distant
    # vegetation retains its actual silhouette at four triangles per tree.
    coords=[o.matrix_world@Vector(c) for o in bpy.context.scene.objects if o.type=='MESH' for c in o.bound_box]
    low=Vector(tuple(min(c[i] for c in coords) for i in range(3)))
    high=Vector(tuple(max(c[i] for c in coords) for i in range(3)))
    mid=(low+high)*.5
    scene=bpy.context.scene
    scene.render.engine='BLENDER_EEVEE'
    scene.world.use_nodes=True
    bg=scene.world.node_tree.nodes.get('Background');bg.inputs[0].default_value=(.3,.35,.4,1);bg.inputs[1].default_value=.6
    bpy.ops.object.light_add(type='AREA',location=(4,-5,9));bpy.context.object.data.energy=800;bpy.context.object.data.size=8
    bpy.ops.object.light_add(type='SUN');bpy.context.object.data.energy=1.6;bpy.context.object.rotation_euler=(.4,-.4,-.6)
    bpy.ops.object.camera_add(location=(mid.x,mid.y-10,mid.z))
    camera=bpy.context.object;camera.rotation_euler=(mid-camera.location).to_track_quat('-Z','Y').to_euler();camera.data.type='ORTHO';camera.data.ortho_scale=(high.z-low.z)*1.04
    scene.camera=camera;scene.render.film_transparent=True
    scene.render.resolution_x=scene.render.resolution_y=768;scene.render.resolution_percentage=100
    scene.render.image_settings.file_format='PNG';scene.render.image_settings.color_mode='RGBA';scene.view_settings.view_transform='AgX'
    scene.render.filepath=str(ROOT/'public'/'textures'/'tree-impostor.png')
    bpy.ops.render.render(write_still=True)
    print('Optimized CC0 tree exported.')
