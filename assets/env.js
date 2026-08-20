/* Environment layer: volumetric fog + GPU particle field, driven by temperature.
   Raw WebGL2, no dependencies. Enhancement only: if anything here fails,
   the page is unchanged and still complete.

   The one idea that makes the freeze read as a freeze: particle motion is driven
   by an accumulated PHASE, not by raw time. As temperature falls, phase stops
   advancing, so particles hold exactly where they were instead of snapping home.
   At absolute zero the field is genuinely static, not slowed. */

export function startEnvironment(canvas) {
  const gl = canvas.getContext('webgl2', {
    alpha: true, antialias: false, depth: false,
    premultipliedAlpha: false, powerPreference: 'high-performance'
  });
  if (!gl) return null;

  const VERT_FOG = `#version 300 es
  const vec2 P[3] = vec2[3](vec2(-1.,-1.), vec2(3.,-1.), vec2(-1.,3.));
  out vec2 vUv;
  void main(){ vec2 p = P[gl_VertexID]; vUv = p*.5+.5; gl_Position = vec4(p,0.,1.); }`;

  /* Fog: layered value-noise FBM, drifting on phase. Cold quantises the field
     into facets and grows bright crystal veins along the facet edges. */
  const FRAG_FOG = `#version 300 es
  precision highp float;
  in vec2 vUv; out vec4 o;
  uniform vec2  uRes;
  uniform float uPhase;   // accumulated drift, stops at absolute zero
  uniform float uTemp;    // 0 = warm, 1 = absolute zero
  uniform float uFade;    // master opacity

  float hash(vec2 p){ return fract(sin(dot(p, vec2(127.1,311.7))) * 43758.5453); }
  float noise(vec2 p){
    vec2 i = floor(p), f = fract(p);
    vec2 u = f*f*(3.-2.*f);
    return mix(mix(hash(i), hash(i+vec2(1,0)), u.x),
               mix(hash(i+vec2(0,1)), hash(i+vec2(1,1)), u.x), u.y);
  }
  float fbm(vec2 p){
    float v = 0., a = .5;
    for(int i=0;i<5;i++){ v += a*noise(p); p *= 2.03; a *= .5; }
    return v;
  }

  void main(){
    vec2 uv = vUv;
    vec2 p  = vec2(uv.x * (uRes.x/max(uRes.y,1.)), uv.y);

    // Two fog sheets at different depths, drifting in opposite directions.
    float t = uPhase;
    float f1 = fbm(p*2.4 + vec2(t*.030, -t*.014));
    float f2 = fbm(p*1.3 + vec2(-t*.017, t*.009) + 11.3);
    float fog = mix(f1, f2, .5);

    // Cold facets the air: quantise the field into cells, then light the seams.
    float cells = 7.0 + uTemp*17.0;
    float faceted = floor(fog*cells)/cells;
    fog = mix(fog, faceted, smoothstep(.30, .96, uTemp));
    float seam = 1.0 - smoothstep(0.0, .055, abs(fog - faceted));
    float veins = seam * smoothstep(.42, 1.0, uTemp);

    // Palette: blue-violet night warms out, ice cyan and white take over.
    vec3 warm = vec3(0.235, 0.196, 0.353);
    vec3 cold = vec3(0.400, 0.678, 0.812);
    vec3 zero = vec3(0.839, 0.925, 0.976);
    vec3 col  = mix(warm, cold, smoothstep(0.0, .62, uTemp));
    col       = mix(col,  zero, smoothstep(.62, 1.0, uTemp));

    // A soft light shaft from upper centre, echoing the footage's moonlight.
    float shaft = smoothstep(.85, .0, distance(uv, vec2(.52,1.06))) * .35;

    float density = (fog*fog) * (.30 + uTemp*.42) + shaft*(.5+uTemp*.5);
    density *= smoothstep(1.25, .12, distance(uv, vec2(.5,.5)));   // vignette inward
    col += veins * vec3(.62,.86,1.0) * .55;

    o = vec4(col, clamp(density,0.,1.) * uFade);
  }`;

  const VERT_PT = `#version 300 es
  in vec4 aSeed;          // xy = home 0..1, z = wander speed, w = size seed
  uniform vec2  uRes;
  uniform float uPhase;
  uniform float uTemp;
  uniform float uDpr;
  out float vGlow;
  void main(){
    float sp = aSeed.z;
    float ph = uPhase * sp;

    // Cheap curl-ish wander. Amplitude shrinks as the world freezes, but the
    // freeze itself comes from uPhase halting, so nothing snaps.
    float amp = mix(0.075, 0.012, uTemp);
    vec2 drift = vec2(
      sin(ph*0.83 + aSeed.w*24.1) * amp + sin(ph*0.31 + aSeed.w*7.7) * amp*.5,
      cos(ph*0.67 + aSeed.w*15.3) * amp * .8 + ph*mix(0.020, 0.0, uTemp)
    );

    vec2 pos = fract(aSeed.xy + drift);
    gl_Position = vec4(pos*2.-1., 0., 1.);

    float base = mix(1.6, 2.9, aSeed.w);          // suspended motes read bigger
    gl_PointSize = base * uDpr * mix(1.0, 1.45, uTemp);
    vGlow = mix(.42, 1.0, aSeed.w) * mix(.55, 1.0, uTemp);
  }`;

  const FRAG_PT = `#version 300 es
  precision highp float;
  in float vGlow; out vec4 o;
  uniform float uTemp;
  uniform float uFade;
  void main(){
    float d = length(gl_PointCoord - .5);
    // Warm motes are soft; frozen ones sharpen into hard crystal points.
    float edge = mix(.5, .22, uTemp);
    float a = smoothstep(.5, edge*.5, d);
    vec3 warm = vec3(.72,.66,.88);
    vec3 cold = vec3(.86,.96,1.0);
    o = vec4(mix(warm, cold, uTemp), a * vGlow * .85 * uFade);
  }`;

  function compile(type, src) {
    const s = gl.createShader(type);
    gl.shaderSource(s, src); gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) || 'shader');
    return s;
  }
  function link(vs, fs) {
    const p = gl.createProgram();
    gl.attachShader(p, compile(gl.VERTEX_SHADER, vs));
    gl.attachShader(p, compile(gl.FRAGMENT_SHADER, fs));
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p) || 'link');
    return p;
  }

  let progFog, progPt;
  try { progFog = link(VERT_FOG, FRAG_FOG); progPt = link(VERT_PT, FRAG_PT); }
  catch (e) { return null; }

  const uf = n => gl.getUniformLocation(progFog, n);
  const up = n => gl.getUniformLocation(progPt, n);
  const U = {
    fRes: uf('uRes'), fPhase: uf('uPhase'), fTemp: uf('uTemp'), fFade: uf('uFade'),
    pRes: up('uRes'), pPhase: up('uPhase'), pTemp: up('uTemp'), pDpr: up('uDpr'), pFade: up('uFade')
  };

  // Particle count scales with screen area, capped hard on small devices.
  // Measured on an Intel UHD: this layer costs about 2.6ms/frame while the hero
  // is scrubbing, so it is kept deliberately lean. The fog is low frequency, so
  // it is rendered below device resolution and scaled up with no visible loss.
  const area = innerWidth * innerHeight;
  const COUNT = Math.max(700, Math.min(3200, Math.round(area / 620)));
  const seeds = new Float32Array(COUNT * 4);
  let s = 20260820 >>> 0;
  const rnd = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
  for (let i = 0; i < COUNT; i++) {
    seeds[i*4+0] = rnd();
    seeds[i*4+1] = rnd();
    seeds[i*4+2] = 0.25 + rnd() * 1.15;
    seeds[i*4+3] = rnd();
  }
  const vao = gl.createVertexArray();
  gl.bindVertexArray(vao);
  const buf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.bufferData(gl.ARRAY_BUFFER, seeds, gl.STATIC_DRAW);
  const loc = gl.getAttribLocation(progPt, 'aSeed');
  gl.enableVertexAttribArray(loc);
  gl.vertexAttribPointer(loc, 4, gl.FLOAT, false, 0, 0);
  gl.bindVertexArray(null);

  const emptyVao = gl.createVertexArray();

  gl.enable(gl.BLEND);
  gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);

  let dpr = 1, W = 0, H = 0;
  function resize() {
    dpr = Math.min(devicePixelRatio || 1, 1) * (innerWidth < 900 ? 0.85 : 0.75);
    W = Math.round(innerWidth * dpr); H = Math.round(innerHeight * dpr);
    if (canvas.width !== W || canvas.height !== H) { canvas.width = W; canvas.height = H; }
    gl.viewport(0, 0, W, H);
  }
  resize();
  addEventListener('resize', resize, { passive: true });

  let temp = 0, phase = 0, fade = 0, last = 0, raf = null, running = false;

  function frame(now) {
    if (!running) { raf = null; return; }
    const dt = Math.min(64, now - (last || now)); last = now;

    // Phase advances only as fast as the world is still allowed to move.
    // At absolute zero this reaches 0 and the field genuinely stops.
    const motion = Math.pow(1 - Math.min(1, Math.max(0, temp)), 2.1);
    phase += (dt / 1000) * motion;
    fade += (1 - fade) * (1 - Math.pow(1 - 0.05, dt / 16.667));

    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);

    gl.useProgram(progFog);
    gl.bindVertexArray(emptyVao);
    gl.uniform2f(U.fRes, W, H);
    gl.uniform1f(U.fPhase, phase);
    gl.uniform1f(U.fTemp, temp);
    gl.uniform1f(U.fFade, fade);
    gl.drawArrays(gl.TRIANGLES, 0, 3);

    gl.useProgram(progPt);
    gl.bindVertexArray(vao);
    gl.uniform2f(U.pRes, W, H);
    gl.uniform1f(U.pPhase, phase);
    gl.uniform1f(U.pTemp, temp);
    gl.uniform1f(U.pDpr, dpr);
    gl.uniform1f(U.pFade, fade);
    gl.drawArrays(gl.POINTS, 0, COUNT);
    gl.bindVertexArray(null);

    raf = requestAnimationFrame(frame);
  }

  function start() { if (running) return; running = true; last = 0; if (raf === null) raf = requestAnimationFrame(frame); }
  function stop()  { running = false; if (raf !== null) { cancelAnimationFrame(raf); raf = null; } }

  document.addEventListener('visibilitychange', () => { document.hidden ? stop() : start(); });
  start();

  return {
    /** 0 = warm night, 1 = absolute zero. */
    setTemp(t) { temp = Math.min(1, Math.max(0, t)); },
    stop, start,
    count: COUNT
  };
}
