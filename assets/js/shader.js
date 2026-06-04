/* TRIBE-inspired neural mesh shader. */
export function mountShader(canvas){
  const gl = canvas.getContext("webgl", { antialias:false, premultipliedAlpha:false, powerPreference:"low-power" })
          || canvas.getContext("experimental-webgl");
  if (!gl){
    canvas.style.background = "linear-gradient(135deg,#0a0a0c,#1a1525)";
    return { stop(){} };
  }

  const vs = `attribute vec2 a_pos; void main(){ gl_Position = vec4(a_pos, 0.0, 1.0); }`;
  const fs = `
    precision mediump float;
    uniform vec2 u_res;
    uniform float u_time;
    uniform vec2 u_mouse;   // smoothed, cursor-leading (see JS lerp)
    uniform float u_pulse;  // 0..1 on-beat envelope, 4s period

    float hash(vec2 p){ p = fract(p*vec2(123.34,456.21)); p += dot(p, p+45.32); return fract(p.x*p.y); }
    float noise(vec2 p){
      vec2 i = floor(p), f = fract(p);
      vec2 u = f*f*(3.0-2.0*f);
      float a = hash(i);
      float b = hash(i+vec2(1.0,0.0));
      float c = hash(i+vec2(0.0,1.0));
      float d = hash(i+vec2(1.0,1.0));
      return mix(mix(a,b,u.x), mix(c,d,u.x), u.y);
    }
    float fbm(vec2 p){
      float v=0.0, a=0.5;
      for(int i=0;i<5;i++){ v+=a*noise(p); p*=2.0; a*=0.5; }
      return v;
    }
    void main(){
      vec2 uv = (gl_FragCoord.xy - 0.5*u_res) / u_res.y;
      vec2 mouse = (u_mouse - 0.5*u_res) / u_res.y;

      // cursor-leading deformation: warp the domain toward the pointer so
      // the mesh "anticipates" the cursor (the lead lives in the JS smoothing).
      float md0 = length(uv - mouse);
      vec2 pull = (mouse - uv) * exp(-md0*2.4) * (0.12 + 0.05*u_pulse);
      vec2 puv = uv + pull;

      float t = u_time * 0.06;
      vec2 q = vec2(fbm(puv*1.5 + t), fbm(puv*1.5 + vec2(5.2,1.3) - t));
      vec2 r = vec2(fbm(puv*1.5 + 4.0*q + vec2(1.7,9.2) + t*0.7),
                    fbm(puv*1.5 + 4.0*q + vec2(8.3,2.8) - t*0.7));
      float f = fbm(puv*1.5 + 4.0*r);

      // ambient wave rides the 4s beat envelope for an on-beat breath.
      float wave = sin(f*9.0 - u_time*1.4) * 0.5 + 0.5;
      wave = pow(wave, 1.6);
      wave *= mix(0.82, 1.0, u_pulse);

      vec3 base = vec3(0.02,0.02,0.03);
      vec3 mid  = vec3(0.706,0.604,1.0);
      vec3 hi   = vec3(0.369,0.918,0.831);

      vec3 col = mix(base, mid, smoothstep(0.35, 0.7, f));
      col = mix(col, hi, smoothstep(0.55, 0.9, f) * wave * 0.9);

      // dendritic seams — sharper on the beat, reads as a cortical mesh.
      float seam = abs(sin(f*24.0 + u_time*0.5));
      seam = smoothstep(0.95 - 0.03*u_pulse, 1.0, seam);
      col += seam * (0.16 + 0.10*u_pulse) * mix(mid, hi, 0.35);

      float band = smoothstep(0.0, 0.02, abs(fract(f*5.0 - u_time*0.1) - 0.5));
      col *= mix(0.78, 1.0, band);

      // pointer halo — leads the eye, brightens slightly on-beat.
      float md = length(uv - mouse);
      col += mix(mid, hi, 0.3) * exp(-md*4.4) * (0.30 + 0.12*u_pulse);
      col += mid * exp(-md*11.0) * 0.22;

      float vig = 1.0 - smoothstep(0.4, 1.4, length(uv));
      col *= vig;
      col = mix(col*0.92, col*0.42, smoothstep(-0.1, 0.5, uv.y));

      gl_FragColor = vec4(col, 1.0);
    }
  `;

  const compile = (src, type) => {
    const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) console.error(gl.getShaderInfoLog(s));
    return s;
  };
  const prog = gl.createProgram();
  gl.attachShader(prog, compile(vs, gl.VERTEX_SHADER));
  gl.attachShader(prog, compile(fs, gl.FRAGMENT_SHADER));
  gl.linkProgram(prog); gl.useProgram(prog);

  const buf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1,-1, 1,-1, -1,1, 1,1]), gl.STATIC_DRAW);
  const loc = gl.getAttribLocation(prog, "a_pos");
  gl.enableVertexAttribArray(loc);
  gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);

  const uRes   = gl.getUniformLocation(prog, "u_res");
  const uTime  = gl.getUniformLocation(prog, "u_time");
  const uMs    = gl.getUniformLocation(prog, "u_mouse");
  const uPulse = gl.getUniformLocation(prog, "u_pulse");
  // target = raw pointer; smooth = where the mesh thinks the cursor is going.
  // We over-extrapolate by ~120ms so the deformation LEADS the pointer (P7).
  let target = [-9999,-9999];
  let smooth = [-9999,-9999];
  let vel    = [0,0];

  const dprCap = 1.5;
  const resize = () => {
    const dpr = Math.min(window.devicePixelRatio || 1, dprCap);
    canvas.width  = Math.floor(canvas.clientWidth  * dpr);
    canvas.height = Math.floor(canvas.clientHeight * dpr);
    gl.viewport(0,0,canvas.width,canvas.height);
  };
  resize();
  window.addEventListener("resize", resize);
  window.addEventListener("mousemove", (e) => {
    const r = canvas.getBoundingClientRect();
    const dpr = Math.min(window.devicePixelRatio || 1, dprCap);
    const nx = (e.clientX - r.left)*dpr, ny = (r.height - (e.clientY - r.top))*dpr;
    target = [nx, ny];
    if (smooth[0] < -9000){ smooth = [nx, ny]; } // seed on first move
  }, { passive:true });

  const reduceMotion = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  let running = true;
  // pause when hero not visible
  const io = new IntersectionObserver(([e]) => { running = e.isIntersecting; if (running) frame(); }, { threshold:0 });
  io.observe(canvas);

  const t0 = performance.now();
  const TAU = Math.PI * 2;
  const BEAT = 4.0; // seconds — the 4s base period (P2)
  let raf = 0;
  const draw = (t) => {
    // on-beat envelope: a soft cardioid pulse on the 4s period.
    const ph = (t % BEAT) / BEAT;
    const pulse = Math.pow(0.5 - 0.5 * Math.cos(ph * TAU), 1.4);
    gl.uniform2f(uRes, canvas.width, canvas.height);
    gl.uniform1f(uTime, t);
    gl.uniform1f(uPulse, pulse);
    gl.uniform2f(uMs, smooth[0], smooth[1]);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  };
  const LEAD = 0.12; // ~120ms anticipation
  const stepMouse = () => {
    if (target[0] < -9000) return;
    // critically-damped follow, then extrapolate forward by LEAD seconds.
    const k = 0.18;
    const nx = smooth[0] + (target[0] - smooth[0]) * k;
    const ny = smooth[1] + (target[1] - smooth[1]) * k;
    vel = [(nx - smooth[0]) * 60, (ny - smooth[1]) * 60]; // px/s @60fps
    smooth = [nx + vel[0] * LEAD, ny + vel[1] * LEAD];
  };
  const frame = () => {
    if (!running) return;
    // honor reduced-motion: render one still composition, no animation loop
    if (reduceMotion){ draw(12.0); return; }
    stepMouse();
    draw((performance.now() - t0) / 1000);
    raf = requestAnimationFrame(frame);
  };
  // keep the still frame correct on resize when motion is reduced (no pointer-driven redraw)
  if (reduceMotion){
    window.addEventListener("resize", () => running && frame());
  }
  frame();

  return { stop(){ running = false; cancelAnimationFrame(raf); io.disconnect(); } };
}
