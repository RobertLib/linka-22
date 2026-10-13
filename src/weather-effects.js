import * as THREE from "three";

// The same pose drives the visible blade and the wiped area of each pane.
export function wiperAngle(time, enabled, side = 0) {
  if (!enabled) return -0.7;
  return Math.sin(time * 3.2 + side * 0.08) * 0.68;
}

export function wiperTip(angle) {
  return {
    x: 0.5 - (Math.sin(angle) * 0.66) / 1.09,
    y: 0.035 + (Math.cos(angle) * 0.66) / 0.84,
  };
}

// UV x runs from left to right on each of the original T3 split panes.
export function windshieldPoint(side, u, v) {
  const outer = side === 0 ? 1 - u : u;
  const bottomZ = -7.014 + outer * 0.152;
  const topZ = -6.837 + outer * 0.143;
  return new THREE.Vector3(
    (side === 0 ? -1.13 : 0.04) + u * 1.09,
    1.79 + v * 0.84,
    bottomZ + (topZ - bottomZ) * v,
  );
}

export function wiperEndpoints(time, enabled, side) {
  const uv = wiperTip(wiperAngle(time, enabled, side));
  const pivot = windshieldPoint(side, 0.5, 0.035);
  const tip = windshieldPoint(side, uv.x, uv.y);
  pivot.z -= 0.008;
  tip.z -= 0.008;
  return { pivot, tip };
}

/** Patchy dampness follows world coordinates, so it never slides with the tram. */
export function prepareWetSurface(material, uniforms) {
  material.onBeforeCompile = (shader) => {
    shader.uniforms.surfaceWetness = uniforms.wetness;
    shader.vertexShader = shader.vertexShader
      .replace(
        "#include <common>",
        "#include <common>\nvarying vec3 vSurfacePosition;",
      )
      .replace(
        "#include <begin_vertex>",
        "#include <begin_vertex>\nvSurfacePosition = (modelMatrix * vec4(transformed, 1.0)).xyz;",
      );
    shader.fragmentShader = shader.fragmentShader
      .replace(
        "#include <common>",
        `#include <common>
      uniform float surfaceWetness;
      varying vec3 vSurfacePosition;
      float wetHash(vec2 p) { return fract(sin(dot(p, vec2(127.1,311.7))) * 43758.5453); }
      float wetNoise(vec2 p) {
        vec2 cell = floor(p), f = fract(p); f = f*f*(3.0-2.0*f);
        return mix(mix(wetHash(cell), wetHash(cell+vec2(1.,0.)), f.x),
          mix(wetHash(cell+vec2(0.,1.)), wetHash(cell+vec2(1.,1.)), f.x), f.y);
      }`,
      )
      .replace(
        "#include <roughnessmap_fragment>",
        `#include <roughnessmap_fragment>
      float dampPattern = wetNoise(vSurfacePosition.xz * 0.38) * 0.72
        + wetNoise(vSurfacePosition.xz * 1.7) * 0.28;
      float puddle = smoothstep(0.57, 0.76, dampPattern) * surfaceWetness;
      roughnessFactor = mix(roughnessFactor, 0.075, puddle);
      roughnessFactor = mix(roughnessFactor, max(0.19, roughnessFactor * 0.60), surfaceWetness * (1.0-puddle));
      diffuseColor.rgb *= mix(1.0, 0.69, surfaceWetness) * (1.0 - puddle * 0.10);`,
      );
  };
  material.customProgramCacheKey = () => "world-dampness-v1";
  material.needsUpdate = true;
}

export function createRiverMaterial(uniforms) {
  const material = new THREE.MeshStandardMaterial({
    color: 0x3f6466,
    roughness: 0.24,
    metalness: 0.25,
    normalMap: new THREE.DataTexture(
      new Uint8Array([128, 128, 255, 255]),
      1,
      1,
    ),
    normalScale: new THREE.Vector2(1, 1),
  });
  material.normalMap.needsUpdate = true;
  material.onBeforeCompile = (shader) => {
    shader.uniforms.waterTime = uniforms.time;
    shader.vertexShader = shader.vertexShader
      .replace(
        "#include <common>",
        "#include <common>\nvarying vec3 vWaterPosition;",
      )
      .replace(
        "#include <begin_vertex>",
        "#include <begin_vertex>\nvWaterPosition = (modelMatrix * vec4(transformed,1.0)).xyz;",
      );
    shader.fragmentShader = shader.fragmentShader
      .replace(
        "#include <common>",
        "#include <common>\nuniform float waterTime;\nvarying vec3 vWaterPosition;",
      )
      .replace(
        "#include <normal_fragment_maps>",
        `
        vec2 p = vWaterPosition.xz;
        float a = sin(p.x * 2.1 + p.y * 1.6 + waterTime * 1.7);
        float b = cos(p.x * 4.3 - p.y * 3.2 - waterTime * 2.2);
        vec3 ripple = normalize(vec3(a * .065 + b * .028, 1., a * .043 - b * .034));
        normal = normalize(mat3(viewMatrix) * ripple);
      `,
      );
  };
  material.customProgramCacheKey = () => "river-ripples-v1";
  return material;
}

/** Water is attached to actual split windscreen geometry, not to the HUD. */
export class WindshieldRain {
  constructor(tram) {
    this.group = new THREE.Group();
    this.group.name = "WindshieldRain";
    this.panes = [];
    this.dropId = 0;
    this.accumulator = 0;
    const width = 256,
      height = 192;
    for (const side of [-1, 1]) {
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext("2d");
      ctx.fillStyle = "black";
      ctx.fillRect(0, 0, width, height);
      const map = new THREE.CanvasTexture(canvas);
      map.minFilter = THREE.LinearFilter;
      map.magFilter = THREE.LinearFilter;
      const material = new THREE.ShaderMaterial({
        transparent: true,
        opacity: 0.2,
        depthWrite: false,
        side: THREE.DoubleSide,
        uniforms: {
          waterMap: { value: map },
          pixel: { value: new THREE.Vector2(1 / width, 1 / height) },
        },
        vertexShader: `varying vec2 vUv; void main() { vUv=uv; gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.); }`,
        fragmentShader: `uniform sampler2D waterMap; uniform vec2 pixel; varying vec2 vUv;
          void main() {
            float h=texture2D(waterMap,vUv).r;
            vec2 gradient=vec2(texture2D(waterMap,vUv+vec2(pixel.x,0.)).r-texture2D(waterMap,vUv-vec2(pixel.x,0.)).r,
              texture2D(waterMap,vUv+vec2(0.,pixel.y)).r-texture2D(waterMap,vUv-vec2(0.,pixel.y)).r);
            float highlight=clamp(.45+gradient.x*.9+gradient.y*.7,0.,1.);
            float alpha=min(.24,h*.075+length(gradient)*.18);
            gl_FragColor=vec4(mix(vec3(.19,.26,.28),vec3(.88,.94,.96),highlight),alpha);
            #include <tonemapping_fragment>
            #include <colorspace_fragment>
          }`,
      });
      const paneSide = side === -1 ? 0 : 1;
      const paneUV = [0, 0, 1, 0, 1, 1, 0, 1];
      const vertices = [];
      for (let i = 0; i < paneUV.length; i += 2)
        vertices.push(
          ...windshieldPoint(paneSide, paneUV[i], paneUV[i + 1]).toArray(),
        );
      const geometry = new THREE.BufferGeometry();
      // A millimetre behind the original pane avoids z fighting.
      geometry.setAttribute(
        "position",
        new THREE.Float32BufferAttribute(vertices, 3),
      );
      geometry.setAttribute("uv", new THREE.Float32BufferAttribute(paneUV, 2));
      geometry.setIndex([0, 1, 2, 0, 2, 3]);
      const mesh = new THREE.Mesh(geometry, material);
      mesh.renderOrder = 3;
      this.group.add(mesh);
      this.panes.push({
        ctx,
        canvas,
        map,
        previousAngle: wiperAngle(0, false),
        side: side === -1 ? 0 : 1,
      });
    }
    tram.add(this.group);
  }
  reset() {
    this.accumulator = 0;
    for (const pane of this.panes) {
      pane.ctx.fillStyle = "black";
      pane.ctx.fillRect(0, 0, pane.canvas.width, pane.canvas.height);
      pane.previousAngle = null;
      pane.map.needsUpdate = true;
    }
  }
  update(dt, time, raining, enabled, visible) {
    this.group.visible = raining && visible;
    if (!raining || !(dt > 0)) return;
    this.accumulator += dt;
    // Texture updates are capped independently of rendering quality/frame rate.
    if (this.accumulator < 1 / 15) return;
    const elapsed = Math.min(this.accumulator, 0.25);
    this.accumulator = 0;
    for (const pane of this.panes) {
      const { ctx, canvas, map } = pane,
        w = canvas.width,
        h = canvas.height;
      // Slowly drain and evaporate, retaining a dirty wet film when wipers stop.
      ctx.fillStyle = `rgba(0,0,0,${1 - Math.exp(-elapsed * 0.075)})`;
      ctx.fillRect(0, 0, w, h);
      const n = Math.ceil(elapsed * 56);
      for (let i = 0; i < n; i++) {
        const seed = ++this.dropId;
        const fract = (v) => v - Math.floor(v);
        const x = fract(Math.sin(seed * 127.1) * 43758.5453) * w;
        const y = fract(Math.sin(seed * 311.7) * 21543.183) * h;
        const r = 0.8 + fract(Math.sin(seed * 51.3) * 17341.17) * 2.2;
        const gradient = ctx.createRadialGradient(x, y, 0, x, y, r);
        gradient.addColorStop(0, "rgba(255,255,255,.95)");
        gradient.addColorStop(0.6, "rgba(215,215,215,.8)");
        gradient.addColorStop(1, "rgba(0,0,0,0)");
        ctx.fillStyle = gradient;
        ctx.beginPath();
        ctx.ellipse(x, y, r, r * 1.35, 0, 0, Math.PI * 2);
        ctx.fill();
        if (r > 2.6) {
          ctx.strokeStyle = "rgba(140,140,140,.3)";
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.moveTo(x, y);
          ctx.lineTo(x + 0.8, y + r * 4);
          ctx.stroke();
        }
      }
      const angle = wiperAngle(time, enabled, pane.side);
      if (enabled) {
        const from = pane.previousAngle ?? angle;
        // Sample the full arc since the last upload; blades never leave gaps at low FPS.
        const steps = Math.max(1, Math.ceil(Math.abs(angle - from) / 0.025));
        ctx.strokeStyle = "black";
        ctx.lineWidth = 6;
        ctx.lineCap = "round";
        for (let i = 0; i <= steps; i++) {
          const tip = wiperTip(from + ((angle - from) * i) / steps);
          ctx.beginPath();
          ctx.moveTo(w * 0.5, h * (1 - 0.035));
          ctx.lineTo(tip.x * w, h * (1 - tip.y));
          ctx.stroke();
        }
      }
      pane.previousAngle = angle;
      map.needsUpdate = true;
    }
  }
}
