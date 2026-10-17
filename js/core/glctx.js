/* ============ glctx.js — el mundo dibujado con WebGL ============
 *
 * Un "contexto" con la misma forma que CanvasRenderingContext2D (la parte que
 * usa el mundo: suelo, props, Pokémon, proyectiles, efectos...) pero que
 * dibuja con WebGL en lotes. game.js le pasa este contexto en vez del 2D y la
 * interfaz (HUD, menús, clima, viñeta) sigue en el canvas 2D, encima, transparente.
 *
 *   capa de abajo:  <canvas id="game-gl">  WebGL  (mundo)
 *   capa de arriba: <canvas id="game">     2D     (HUD, avisos, táctil)
 *
 * - Triángulos con textura en UN búfer dinámico; las formas lisas usan una
 *   textura blanca 1×1, así van en el mismo lote que los sprites.
 * - Hasta 16 texturas por lote (índice por vértice).
 * - Transformaciones en CPU, alfa premultiplicado, NEAREST (pixel art).
 * - Textos rasterizados con el canvas 2D a la escala de pantalla, en un atlas.
 * - Degradados evaluados por vértice sobre la forma subdividida.
 *
 * Aproximaciones: fill() en abanico (formas convexas); shadowBlur sólo en
 * stroke() como halo; clip()/filter no hacen nada; composición sólo
 * 'source-over' y 'lighter'; degradados radiales como concéntricos.
 *
 * ?renderer=canvas -> 2D de siempre · ?renderer=webgl (por defecto).
 */
G.GLCtx = (() => {
  const TAU = Math.PI * 2;
  const MAX_V = 6 * 8192;
  const FLOATS = 6;                   // x, y, u, v, color (u32), textura (u32)
  const ATLAS = 2048;
  const TEX_IDLE_MS = 15000;

  // ---------------- colores ----------------

  const colors = new Map();
  let probe = null;
  function parseColor(s) {
    let c = colors.get(s);
    if (c !== undefined) return c;
    c = parseRaw(s.trim().toLowerCase());
    if (colors.size > 4096) colors.clear();
    colors.set(s, c);
    return c;
  }
  function parseRaw(s) {
    if (s[0] === '#') {
      const h = s.slice(1);
      if (/^[0-9a-f]{3,4}$/.test(h)) {
        const v = [...h].map(x => parseInt(x + x, 16));
        return [v[0], v[1], v[2], h.length === 4 ? v[3] / 255 : 1];
      }
      if (/^[0-9a-f]{6}([0-9a-f]{2})?$/.test(h)) {
        const n = parseInt(h.slice(0, 6), 16);
        return [n >> 16 & 255, n >> 8 & 255, n & 255, h.length === 8 ? parseInt(h.slice(6), 16) / 255 : 1];
      }
      return null;
    }
    const m = /^rgba?\(\s*([-\d.]+%?)\s*[, ]\s*([-\d.]+%?)\s*[, ]\s*([-\d.]+%?)\s*(?:[,/]\s*([-\d.]+%?)\s*)?\)$/.exec(s);
    if (m) {
      if ([m[1], m[2], m[3]].some(v => isNaN(parseFloat(v)))) return null;
      const ch = v => Math.min(255, Math.max(0, v.endsWith('%') ? parseFloat(v) * 2.55 : parseFloat(v)));
      const al = m[4] == null ? 1 : m[4].endsWith('%') ? parseFloat(m[4]) / 100 : parseFloat(m[4]);
      if (isNaN(al)) return null;
      return [ch(m[1]), ch(m[2]), ch(m[3]), Math.min(1, Math.max(0, al))];
    }
    // Nombres, hsl()...: que lo traduzca el canvas 2D.
    if (!probe) probe = document.createElement('canvas').getContext('2d');
    probe.fillStyle = '#010203';
    probe.fillStyle = s;
    const r = String(probe.fillStyle).replace(/\s+/g, '');
    if (r === '#010203' && s !== '#010203') return null;
    return r[0] === '#' || r.startsWith('rgb') ? parseRaw(r) : null;
  }

  /** Color premultiplicado empaquetado (ABGR en memoria little-endian). */
  function pack(c, alpha) {
    const a = c[3] * alpha;
    return ((Math.round(a * 255) << 24) | (Math.round(c[2] * a) << 16) | (Math.round(c[1] * a) << 8) | Math.round(c[0] * a)) >>> 0;
  }
  function grey(al) { const A = Math.round(al * 255); return ((A << 24) | (A << 16) | (A << 8) | A) >>> 0; }

  // ---------------- degradados ----------------

  class Grad {
    constructor(type, x0, y0, r0, x1, y1, r1) {
      this.type = type;
      this.x0 = x0; this.y0 = y0; this.r0 = r0;
      this.x1 = x1; this.y1 = y1; this.r1 = r1;
      this.stops = [];
    }
    addColorStop(off, col) {
      const c = parseColor(String(col));
      if (!c || !(off >= 0 && off <= 1)) return;
      this.stops.push([off, c]);
      this.stops.sort((a, b) => a[0] - b[0]);
    }
    at(x, y, out) {
      let t;
      if (this.type === 'linear') {
        const dx = this.x1 - this.x0, dy = this.y1 - this.y0, L = dx * dx + dy * dy;
        t = L ? ((x - this.x0) * dx + (y - this.y0) * dy) / L : 0;
      } else {
        const d = Math.hypot(x - this.x1, y - this.y1), dr = this.r1 - this.r0;
        t = dr ? (d - this.r0) / dr : 0;
      }
      const S = this.stops;
      if (!S.length) { out[0] = out[1] = out[2] = out[3] = 0; return out; }
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      let i = 0;
      while (i < S.length - 1 && S[i + 1][0] < t) i++;
      const a = S[i], b = S[Math.min(i + 1, S.length - 1)];
      const k = b[0] > a[0] ? Math.min(1, Math.max(0, (t - a[0]) / (b[0] - a[0]))) : t >= b[0] ? 1 : 0;
      for (let j = 0; j < 4; j++) out[j] = a[1][j] + (b[1][j] - a[1][j]) * k;
      return out;
    }
    mid() { const S = this.stops; return S.length ? S[S.length >> 1][1] : [0, 0, 0, 0]; }
  }

  // ---------------- shaders ----------------

  const VS = `attribute vec2 aPos;
attribute vec2 aUV;
attribute vec4 aCol;
attribute float aTex;
uniform vec2 uRes;
varying vec2 vUV;
varying vec4 vCol;
varying float vTex;
void main() {
  vUV = aUV; vCol = aCol; vTex = aTex;
  gl_Position = vec4(aPos.x / uRes.x * 2.0 - 1.0, 1.0 - aPos.y / uRes.y * 2.0, 0.0, 1.0);
}`;
  function fragment(n) {
    let s = `#ifdef GL_FRAGMENT_PRECISION_HIGH
precision highp float;
#else
precision mediump float;
#endif
uniform sampler2D uT[${n}];
varying vec2 vUV;
varying vec4 vCol;
varying float vTex;
void main() {
  vec4 c;
`;
    for (let i = 0; i < n; i++) {
      s += (i ? '  else ' : '  ') + (i < n - 1 ? `if (vTex < ${i}.5) ` : '') + `c = texture2D(uT[${i}], vUV);\n`;
    }
    return s + '  gl_FragColor = c * vCol;\n}';
  }

  function compile(gl, type, src) {
    const sh = gl.createShader(type);
    gl.shaderSource(sh, src);
    gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) throw new Error('shader: ' + gl.getShaderInfoLog(sh));
    return sh;
  }

  // ---------------- el contexto ----------------

  const STATE_KEYS = ['a', 'b', 'c', 'd', 'e', 'f', '_alpha', '_fill', '_fillRaw', '_stroke', '_strokeRaw', '_lw',
                      '_font', '_align', '_baseline', '_dash', '_shBlur', '_shColor', '_shRaw', '_comp', '_join', '_cap', '_smooth'];

  class GLCtx {
    constructor(overlay) {
      const cv = document.createElement('canvas');
      cv.id = 'game-gl';
      cv.style.cssText = 'position:fixed;left:0;top:0;display:block;pointer-events:none;z-index:0';
      const opts = { alpha: true, premultipliedAlpha: true, antialias: true, depth: false, stencil: false,
                     preserveDrawingBuffer: false, powerPreference: 'high-performance' };
      const gl = cv.getContext('webgl', opts) || cv.getContext('experimental-webgl', opts);
      if (!gl) throw new Error('WebGL no disponible');
      this.canvas = cv;
      this.gl = gl;
      this.overlay = overlay;
      this.lost = false;
      cv.addEventListener('webglcontextlost', e => { e.preventDefault(); this.lost = true; });

      this.units = Math.max(1, Math.min(16, gl.getParameter(gl.MAX_TEXTURE_IMAGE_UNITS)));
      const prog = gl.createProgram();
      gl.attachShader(prog, compile(gl, gl.VERTEX_SHADER, VS));
      gl.attachShader(prog, compile(gl, gl.FRAGMENT_SHADER, fragment(this.units)));
      gl.bindAttribLocation(prog, 0, 'aPos');
      gl.bindAttribLocation(prog, 1, 'aUV');
      gl.bindAttribLocation(prog, 2, 'aCol');
      gl.bindAttribLocation(prog, 3, 'aTex');
      gl.linkProgram(prog);
      if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error('programa: ' + gl.getProgramInfoLog(prog));
      gl.useProgram(prog);
      this.uRes = gl.getUniformLocation(prog, 'uRes');
      gl.uniform1iv(gl.getUniformLocation(prog, 'uT'), Array.from({ length: this.units }, (_, i) => i));

      this.buf = new ArrayBuffer(MAX_V * FLOATS * 4);
      this.f32 = new Float32Array(this.buf);
      this.u32 = new Uint32Array(this.buf);
      this.vbo = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo);
      gl.bufferData(gl.ARRAY_BUFFER, this.buf.byteLength, gl.DYNAMIC_DRAW);
      const S = FLOATS * 4;
      gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 2, gl.FLOAT, false, S, 0);
      gl.enableVertexAttribArray(1); gl.vertexAttribPointer(1, 2, gl.FLOAT, false, S, 8);
      gl.enableVertexAttribArray(2); gl.vertexAttribPointer(2, 4, gl.UNSIGNED_BYTE, true, S, 16);
      gl.enableVertexAttribArray(3); gl.vertexAttribPointer(3, 1, gl.UNSIGNED_BYTE, false, S, 20);

      gl.disable(gl.DEPTH_TEST);
      gl.disable(gl.CULL_FACE);
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
      gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.NONE);

      this.nv = 0;
      this.bound = new Array(this.units).fill(null);
      this.white = this._newTex(1, 1, new Uint8Array([255, 255, 255, 255]), false);
      this.slots = [this.white];
      this.blend = 'source-over';
      this.texCache = new Map();
      this.now = performance.now();
      this.lastEvict = this.now;

      this.atlasSize = Math.min(ATLAS, gl.getParameter(gl.MAX_TEXTURE_SIZE));
      this.atlas = this._newTex(this.atlasSize, this.atlasSize, null, true);
      this.texts = new Map();
      this.shelfX = 0; this.shelfY = 0; this.shelfH = 0;
      this.scratch = document.createElement('canvas');
      this.sctx = this.scratch.getContext('2d');
      this.textsDirty = false;
      if (document.fonts && document.fonts.addEventListener) {
        this._onFonts = () => { this.textsDirty = true; };
        document.fonts.addEventListener('loadingdone', this._onFonts);
      }

      this.stack = [];
      this.depth = 0;
      this._reset();
      this.path = [];
      this.cur = null;
      this.stats = { draws: 0, verts: 0 };

      overlay.parentNode.insertBefore(cv, overlay);
      this._ovPos = overlay.style.position; this._ovZ = overlay.style.zIndex;
      if (getComputedStyle(overlay).position === 'static') overlay.style.position = 'relative';
      overlay.style.zIndex = '1';
    }

    _reset() {
      this.a = 1; this.b = 0; this.c = 0; this.d = 1; this.e = 0; this.f = 0;
      this._alpha = 1;
      this._fill = [0, 0, 0, 1]; this._fillRaw = '#000000';
      this._stroke = [0, 0, 0, 1]; this._strokeRaw = '#000000';
      this._lw = 1;
      this._font = '10px sans-serif';
      this._align = 'start'; this._baseline = 'alphabetic';
      this._dash = [];
      this._shBlur = 0; this._shColor = [0, 0, 0, 0]; this._shRaw = 'rgba(0, 0, 0, 0)';
      this._comp = 'source-over';
      this._join = 'miter'; this._cap = 'butt';
      this._smooth = true;
      this.depth = 0;
    }

    // ---------------- propiedades ----------------

    get globalAlpha() { return this._alpha; }
    set globalAlpha(v) { if (v >= 0 && v <= 1) this._alpha = v; }
    get fillStyle() { return this._fillRaw; }
    set fillStyle(v) {
      if (v instanceof Grad) { this._fill = v; this._fillRaw = v; return; }
      if (typeof v !== 'string') return;
      const c = parseColor(v);
      if (c) { this._fill = c; this._fillRaw = v; }
    }
    get strokeStyle() { return this._strokeRaw; }
    set strokeStyle(v) {
      if (v instanceof Grad) { this._stroke = v; this._strokeRaw = v; return; }
      if (typeof v !== 'string') return;
      const c = parseColor(v);
      if (c) { this._stroke = c; this._strokeRaw = v; }
    }
    get lineWidth() { return this._lw; }
    set lineWidth(v) { if (v > 0 && isFinite(v)) this._lw = +v; }
    get font() { return this._font; }
    set font(v) { this._font = String(v); }
    get textAlign() { return this._align; }
    set textAlign(v) { this._align = v; }
    get textBaseline() { return this._baseline; }
    set textBaseline(v) { this._baseline = v; }
    get lineJoin() { return this._join; }
    set lineJoin(v) { this._join = v; }
    get lineCap() { return this._cap; }
    set lineCap(v) { this._cap = v; }
    get shadowBlur() { return this._shBlur; }
    set shadowBlur(v) { if (v >= 0 && isFinite(v)) this._shBlur = v; }
    get shadowColor() { return this._shRaw; }
    set shadowColor(v) { const c = typeof v === 'string' && parseColor(v); if (c) { this._shColor = c; this._shRaw = v; } }
    get globalCompositeOperation() { return this._comp; }
    set globalCompositeOperation(v) { this._comp = v === 'lighter' ? 'lighter' : 'source-over'; }
    get imageSmoothingEnabled() { return this._smooth; }
    set imageSmoothingEnabled(v) { this._smooth = !!v; }
    get filter() { return 'none'; }
    set filter(v) { /* no soportado */ }
    get shadowOffsetX() { return 0; }
    set shadowOffsetX(v) { /* no soportado */ }
    get shadowOffsetY() { return 0; }
    set shadowOffsetY(v) { /* no soportado */ }
    get lineDashOffset() { return 0; }
    set lineDashOffset(v) { /* no soportado */ }
    get miterLimit() { return 10; }
    set miterLimit(v) { /* fijo */ }

    // ---------------- pila y transformaciones ----------------

    save() {
      let s = this.stack[this.depth];
      if (!s) s = this.stack[this.depth] = {};
      for (let i = 0; i < STATE_KEYS.length; i++) s[STATE_KEYS[i]] = this[STATE_KEYS[i]];
      this.depth++;
    }
    restore() {
      if (!this.depth) return;
      const s = this.stack[--this.depth];
      for (let i = 0; i < STATE_KEYS.length; i++) this[STATE_KEYS[i]] = s[STATE_KEYS[i]];
    }
    setTransform(a, b, c, d, e, f) {
      if (typeof a === 'object' && a) ({ a, b, c, d, e, f } = a);
      this.a = a; this.b = b; this.c = c; this.d = d; this.e = e; this.f = f;
    }
    resetTransform() { this.setTransform(1, 0, 0, 1, 0, 0); }
    transform(a, b, c, d, e, f) {
      const A = this.a, B = this.b, C = this.c, D = this.d;
      this.e += A * e + C * f; this.f += B * e + D * f;
      this.a = A * a + C * b; this.b = B * a + D * b;
      this.c = A * c + C * d; this.d = B * c + D * d;
    }
    translate(x, y) { this.e += this.a * x + this.c * y; this.f += this.b * x + this.d * y; }
    scale(x, y) { this.a *= x; this.b *= x; this.c *= y; this.d *= y; }
    rotate(r) {
      const cs = Math.cos(r), sn = Math.sin(r);
      const A = this.a, B = this.b, C = this.c, D = this.d;
      this.a = A * cs + C * sn; this.b = B * cs + D * sn;
      this.c = C * cs - A * sn; this.d = D * cs - B * sn;
    }
    getTransform() { return new DOMMatrix([this.a, this.b, this.c, this.d, this.e, this.f]); }
    _scale() { return Math.sqrt(Math.abs(this.a * this.d - this.b * this.c)) || 0; }

    setLineDash(d) {
      if (!Array.isArray(d) || !d.every(v => v >= 0 && isFinite(v))) return;
      this._dash = d.length % 2 ? d.concat(d) : d.slice();
    }
    getLineDash() { return this._dash.slice(); }

    // ---------------- lotes ----------------

    /** Hueco para k vértices (y modo de mezcla al día). Siempre antes de _slot(). */
    _prep(k) {
      if (this.blend !== this._comp) {
        this.flush();
        this.blend = this._comp;
        const gl = this.gl;
        if (this.blend === 'lighter') gl.blendFunc(gl.ONE, gl.ONE);
        else gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
      }
      if (this.nv + k > MAX_V) this.flush();
    }

    _slot(tex) {
      const S = this.slots;
      for (let i = 0; i < S.length; i++) if (S[i] === tex) return i;
      if (S.length >= this.units) this.flush();
      S.push(tex);
      return S.length - 1;
    }

    _v(x, y, u, v, col, ti) {
      const i = this.nv++ * FLOATS, f = this.f32;
      f[i] = x; f[i + 1] = y; f[i + 2] = u; f[i + 3] = v;
      this.u32[i + 4] = col; this.u32[i + 5] = ti;
    }

    _quad(x0, y0, x1, y1, x2, y2, x3, y3, u0, v0, u1, v1, col, ti) {
      this._v(x0, y0, u0, v0, col, ti); this._v(x1, y1, u1, v0, col, ti); this._v(x2, y2, u1, v1, col, ti);
      this._v(x0, y0, u0, v0, col, ti); this._v(x2, y2, u1, v1, col, ti); this._v(x3, y3, u0, v1, col, ti);
    }

    flush() {
      const n = this.nv;
      if (!n) { this.slots.length = 1; return; }
      const gl = this.gl;
      for (let i = 0; i < this.slots.length; i++) {
        if (this.bound[i] !== this.slots[i]) {
          gl.activeTexture(gl.TEXTURE0 + i);
          gl.bindTexture(gl.TEXTURE_2D, this.slots[i]);
          this.bound[i] = this.slots[i];
        }
      }
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, this.f32.subarray(0, n * FLOATS));
      gl.drawArrays(gl.TRIANGLES, 0, n);
      this.stats.draws++; this.stats.verts += n;
      this.nv = 0;
      this.slots.length = 1;
    }

    // ---------------- texturas ----------------

    /** Sube/crea en la unidad 0. Ojo: invalida lo que haya en la unidad 0 del lote -> flush antes. */
    _bind0(t) {
      const gl = this.gl;
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, t);
      this.bound[0] = t;
    }

    _newTex(w, h, data, linear) {
      const gl = this.gl, t = gl.createTexture();
      this._bind0(t);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, linear ? gl.LINEAR : gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, linear ? gl.LINEAR : gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, data);
      return t;
    }

    _upload(t, src) {
      const gl = this.gl;
      this._bind0(t);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, src);
    }

    _tex(src) {
      const img = typeof HTMLImageElement !== 'undefined' && src instanceof HTMLImageElement;
      if (img && (!src.complete || !src.naturalWidth)) return null;
      const w = img ? src.naturalWidth : src.width, h = img ? src.naturalHeight : src.height;
      if (!w || !h) return null;
      let e = this.texCache.get(src);
      const url = img ? src.src : null;
      if (!e) {
        const t = this._newTex(1, 1, null, false);
        this._upload(t, src);
        e = { tex: t, w, h, url, used: this.now };
        this.texCache.set(src, e);
      } else if (e.w !== w || e.h !== h || e.url !== url) {
        this.flush();
        this._upload(e.tex, src);
        e.w = w; e.h = h; e.url = url;
      }
      e.used = this.now;
      return e;
    }

    _evict() {
      for (const [src, e] of this.texCache) {
        if (this.now - e.used > TEX_IDLE_MS) {
          this.gl.deleteTexture(e.tex);
          this.texCache.delete(src);
          for (let i = 0; i < this.bound.length; i++) if (this.bound[i] === e.tex) this.bound[i] = null;
        }
      }
    }

    /** Para un canvas ya usado como textura que se ha vuelto a pintar. */
    invalidate(src) {
      const e = this.texCache.get(src);
      if (!e) return;
      this.flush();
      this._upload(e.tex, src);
    }

    // ---------------- fotograma ----------------

    begin(w, h, dpr) {
      if (this.lost || this.gl.isContextLost()) throw new Error('WebGL: contexto perdido');
      const cv = this.canvas, W = Math.round(w * dpr), H = Math.round(h * dpr);
      if (cv.width !== W || cv.height !== H) { cv.width = W; cv.height = H; }
      if (cv.style.width !== w + 'px') cv.style.width = w + 'px';
      if (cv.style.height !== h + 'px') cv.style.height = h + 'px';
      const gl = this.gl;
      gl.viewport(0, 0, W, H);
      gl.uniform2f(this.uRes, W, H);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      this.now = performance.now();
      this.stats.draws = 0; this.stats.verts = 0;
      this._reset();
      this.path = []; this.cur = null;
      if (this.textsDirty) { this.textsDirty = false; this._resetAtlas(); }
      if (this.now - this.lastEvict > 3000) { this.lastEvict = this.now; this._evict(); }
    }

    end() { this.flush(); }

    destroy() {
      try {
        if (this._onFonts && document.fonts) document.fonts.removeEventListener('loadingdone', this._onFonts);
        for (const e of this.texCache.values()) this.gl.deleteTexture(e.tex);
        this.texCache.clear();
        const ext = this.gl.getExtension('WEBGL_lose_context');
        if (ext) ext.loseContext();
      } catch (e) { /* da igual */ }
      this.canvas.remove();
      this.overlay.style.position = this._ovPos;
      this.overlay.style.zIndex = this._ovZ;
    }

    clearRect(x, y, w, h) {
      if (this.b || this.c) return;
      this.flush();
      const gl = this.gl, H = this.canvas.height;
      let x0 = this.a * x + this.e, y0 = this.d * y + this.f, x1 = this.a * (x + w) + this.e, y1 = this.d * (y + h) + this.f;
      if (x0 > x1) { const t = x0; x0 = x1; x1 = t; }
      if (y0 > y1) { const t = y0; y0 = y1; y1 = t; }
      gl.enable(gl.SCISSOR_TEST);
      gl.scissor(Math.round(x0), Math.round(H - y1), Math.max(0, Math.round(x1 - x0)), Math.max(0, Math.round(y1 - y0)));
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.disable(gl.SCISSOR_TEST);
    }

    // ---------------- imágenes ----------------

    drawImage(src, a1, a2, a3, a4, a5, a6, a7, a8) {
      const al = this._alpha;
      if (al <= 0 || !src) return;
      const n = arguments.length;
      const t = this._tex(src);
      if (!t) return;
      let sx = 0, sy = 0, sw = t.w, sh = t.h, dx, dy, dw, dh;
      if (n <= 3) { dx = a1; dy = a2; dw = t.w; dh = t.h; }
      else if (n <= 5) { dx = a1; dy = a2; dw = a3; dh = a4; }
      else { sx = a1; sy = a2; sw = a3; sh = a4; dx = a5; dy = a6; dw = a7; dh = a8; }
      if (!sw || !sh || !dw || !dh) return;
      this._prep(6);
      const ti = this._slot(t.tex);
      const col = grey(al);
      const a = this.a, b = this.b, c = this.c, d = this.d;
      const x0 = a * dx + c * dy + this.e, y0 = b * dx + d * dy + this.f;
      const wx = a * dw, wy = b * dw, hx = c * dh, hy = d * dh;
      this._quad(x0, y0, x0 + wx, y0 + wy, x0 + wx + hx, y0 + wy + hy, x0 + hx, y0 + hy,
                 sx / t.w, sy / t.h, (sx + sw) / t.w, (sy + sh) / t.h, col, ti);
    }

    // ---------------- rectángulos ----------------

    fillRect(x, y, w, h) {
      if (!w || !h) return;
      if (this._fill instanceof Grad) { this._fillGrad([this._rectPts(x, y, w, h)], this._fill); return; }
      const col = pack(this._fill, this._alpha);
      if (!(col >>> 24)) return;
      this._prep(6);
      const a = this.a, b = this.b, c = this.c, d = this.d;
      const x0 = a * x + c * y + this.e, y0 = b * x + d * y + this.f;
      const wx = a * w, wy = b * w, hx = c * h, hy = d * h;
      this._quad(x0, y0, x0 + wx, y0 + wy, x0 + wx + hx, y0 + wy + hy, x0 + hx, y0 + hy, 0.5, 0.5, 0.5, 0.5, col, 0);
    }

    strokeRect(x, y, w, h) { this._strokeSubs([{ pts: this._rectPts(x, y, w, h), closed: true }]); }

    _rectPts(x, y, w, h) {
      const a = this.a, b = this.b, c = this.c, d = this.d, e = this.e, f = this.f;
      return [a * x + c * y + e, b * x + d * y + f,
              a * (x + w) + c * y + e, b * (x + w) + d * y + f,
              a * (x + w) + c * (y + h) + e, b * (x + w) + d * (y + h) + f,
              a * x + c * (y + h) + e, b * x + d * (y + h) + f];
    }

    // ---------------- caminos (guardados ya en píxeles de pantalla) ----------------

    beginPath() { this.path = []; this.cur = null; }

    moveTo(x, y) {
      this.cur = { pts: [this.a * x + this.c * y + this.e, this.b * x + this.d * y + this.f], closed: false };
      this.path.push(this.cur);
    }

    _lineDev(X, Y) {
      if (!this.cur) { this.cur = { pts: [X, Y], closed: false }; this.path.push(this.cur); return; }
      if (this.cur.closed) {
        const p = this.cur.pts;
        this.cur = { pts: [p[0], p[1]], closed: false };
        this.path.push(this.cur);
      }
      this.cur.pts.push(X, Y);
    }

    lineTo(x, y) { this._lineDev(this.a * x + this.c * y + this.e, this.b * x + this.d * y + this.f); }

    closePath() { if (this.cur && this.cur.pts.length) this.cur.closed = true; }

    rect(x, y, w, h) {
      this.cur = { pts: this._rectPts(x, y, w, h), closed: true };
      this.path.push(this.cur);
    }

    arc(x, y, r, s, e, ccw) { this.ellipse(x, y, r, r, 0, s, e, ccw); }

    ellipse(x, y, rx, ry, rot, s, e, ccw) {
      if (!(rx >= 0 && ry >= 0)) return;
      let sweep = e - s;
      if (!ccw) { if (sweep >= TAU) sweep = TAU; else { sweep %= TAU; if (sweep < 0) sweep += TAU; } }
      else if (sweep <= -TAU) sweep = -TAU;
      else { sweep %= TAU; if (sweep > 0) sweep -= TAU; }
      const full = Math.abs(sweep) >= TAU;
      const rDev = Math.max(rx, ry) * this._scale();
      const segFull = Math.min(128, Math.max(12, Math.ceil(Math.sqrt(rDev) * 5)));
      const n = Math.max(2, Math.ceil(segFull * Math.abs(sweep) / TAU));
      const cr = Math.cos(rot || 0), sr = Math.sin(rot || 0);
      const a = this.a, b = this.b, c = this.c, d = this.d, E = this.e, F = this.f;
      const fresh = !this.cur || this.cur.closed || this.cur.pts.length < 2;
      const last = full && fresh ? n - 1 : n;
      for (let i = 0; i <= last; i++) {
        const t = s + sweep * i / n, ct = Math.cos(t), st = Math.sin(t);
        const px = x + rx * ct * cr - ry * st * sr, py = y + rx * ct * sr + ry * st * cr;
        const X = a * px + c * py + E, Y = b * px + d * py + F;
        if (i === 0 && fresh) { this.cur = { pts: [X, Y], closed: false }; this.path.push(this.cur); }
        else this._lineDev(X, Y);
      }
      if (full && fresh) this.cur.closed = true;
    }

    quadraticCurveTo(cx, cy, x, y) {
      if (!this.cur) this.moveTo(cx, cy);
      const p = this.cur.pts, n = p.length;
      const q = this._inv(p[n - 2], p[n - 1]);
      for (let i = 1; i <= 12; i++) {
        const t = i / 12, u = 1 - t;
        this.lineTo(u * u * q[0] + 2 * u * t * cx + t * t * x, u * u * q[1] + 2 * u * t * cy + t * t * y);
      }
    }

    bezierCurveTo(c1x, c1y, c2x, c2y, x, y) {
      if (!this.cur) this.moveTo(c1x, c1y);
      const p = this.cur.pts, n = p.length;
      const q = this._inv(p[n - 2], p[n - 1]);
      for (let i = 1; i <= 16; i++) {
        const t = i / 16, u = 1 - t;
        this.lineTo(u * u * u * q[0] + 3 * u * u * t * c1x + 3 * u * t * t * c2x + t * t * t * x,
                    u * u * u * q[1] + 3 * u * u * t * c1y + 3 * u * t * t * c2y + t * t * t * y);
      }
    }

    clip() { /* no soportado */ }

    _inv(X, Y) {
      const a = this.a, b = this.b, c = this.c, d = this.d, det = a * d - b * c;
      if (!det) return [0, 0];
      const x = X - this.e, y = Y - this.f;
      return [(d * x - c * y) / det, (a * y - b * x) / det];
    }

    // ---------------- relleno ----------------

    fill() {
      if (this._fill instanceof Grad) { this._fillGrad(this.path.map(s => s.pts), this._fill); return; }
      const col = pack(this._fill, this._alpha);
      if (!(col >>> 24)) return;
      for (const sub of this.path) this._fan(sub.pts, col);
    }

    _fan(p, col) {
      const n = p.length >> 1;
      if (n < 3) return;
      let cx = 0, cy = 0;
      for (let i = 0; i < p.length; i += 2) { cx += p[i]; cy += p[i + 1]; }
      cx /= n; cy /= n;
      this._prep(n * 3);
      for (let i = 0; i < n; i++) {
        const j = i + 1 < n ? i + 1 : 0;
        this._v(cx, cy, 0.5, 0.5, col, 0);
        this._v(p[i * 2], p[i * 2 + 1], 0.5, 0.5, col, 0);
        this._v(p[j * 2], p[j * 2 + 1], 0.5, 0.5, col, 0);
      }
    }

    _fillGrad(subs, g) {
      const RINGS = 8, tmp = [0, 0, 0, 0], al = this._alpha;
      const colAt = (X, Y) => { const q = this._inv(X, Y); return pack(g.at(q[0], q[1], tmp), al); };
      for (const raw of subs) {
        let n = raw.length >> 1;
        if (n < 3) continue;
        let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
        for (let i = 0; i < raw.length; i += 2) {
          x0 = Math.min(x0, raw[i]); x1 = Math.max(x1, raw[i]); y0 = Math.min(y0, raw[i + 1]); y1 = Math.max(y1, raw[i + 1]);
        }
        const maxSeg = Math.max(4, Math.hypot(x1 - x0, y1 - y0) / 16);
        const p = [];
        for (let i = 0; i < n; i++) {
          const j = (i + 1) % n, ax = raw[i * 2], ay = raw[i * 2 + 1], bx = raw[j * 2], by = raw[j * 2 + 1];
          const k = Math.max(1, Math.ceil(Math.hypot(bx - ax, by - ay) / maxSeg));
          for (let s = 0; s < k; s++) p.push(ax + (bx - ax) * s / k, ay + (by - ay) * s / k);
        }
        n = p.length >> 1;
        let cx = 0, cy = 0;
        for (let i = 0; i < p.length; i += 2) { cx += p[i]; cy += p[i + 1]; }
        cx /= n; cy /= n;
        const ring = [];
        for (let r = 0; r <= RINGS; r++) {
          const k = r / RINGS, row = new Array(n * 3);
          for (let i = 0; i < n; i++) {
            const X = cx + (p[i * 2] - cx) * k, Y = cy + (p[i * 2 + 1] - cy) * k;
            row[i * 3] = X; row[i * 3 + 1] = Y; row[i * 3 + 2] = colAt(X, Y);
          }
          ring.push(row);
        }
        for (let r = 0; r < RINGS; r++) {
          const A = ring[r], B = ring[r + 1];
          this._prep(n * 6);
          for (let i = 0; i < n; i++) {
            const i3 = i * 3, j3 = ((i + 1) % n) * 3;
            this._v(A[i3], A[i3 + 1], 0.5, 0.5, A[i3 + 2], 0);
            this._v(B[i3], B[i3 + 1], 0.5, 0.5, B[i3 + 2], 0);
            this._v(B[j3], B[j3 + 1], 0.5, 0.5, B[j3 + 2], 0);
            this._v(A[i3], A[i3 + 1], 0.5, 0.5, A[i3 + 2], 0);
            this._v(B[j3], B[j3 + 1], 0.5, 0.5, B[j3 + 2], 0);
            this._v(A[j3], A[j3 + 1], 0.5, 0.5, A[j3 + 2], 0);
          }
        }
      }
    }

    // ---------------- trazos ----------------

    stroke() { this._strokeSubs(this.path); }

    _strokeSubs(subs) {
      const sc = this._scale();
      const hw = this._lw * sc / 2;
      if (!(hw > 0)) return;
      const base = this._stroke instanceof Grad ? this._stroke.mid() : this._stroke;
      if (this._shBlur > 0 && this._shColor[3] > 0) {
        const blur = this._shBlur * sc;
        const glow1 = pack(this._shColor, this._alpha * 0.22), glow2 = pack(this._shColor, this._alpha * 0.3);
        for (const s of subs) this._strokeSub(s, hw + blur * 0.6, glow1, sc);
        for (const s of subs) this._strokeSub(s, hw + blur * 0.25, glow2, sc);
      }
      const col = pack(base, this._alpha);
      if (!(col >>> 24)) return;
      for (const s of subs) this._strokeSub(s, hw, col, sc);
    }

    _strokeSub(sub, hw, col, sc) {
      let p = sub.pts;
      if (p.length < 4) return;
      if (!this._dash.some(v => v > 0)) { this._polyline(p, sub.closed, hw, col); return; }
      const D = this._dash.map(v => v * sc);
      if (sub.closed) p = p.concat(p[0], p[1]);
      let di = 0, left = D[0], on = true, piece = [p[0], p[1]];
      for (let i = 2; i < p.length; i += 2) {
        let ax = p[i - 2], ay = p[i - 1], len = Math.hypot(p[i] - ax, p[i + 1] - ay);
        const bx = p[i], by = p[i + 1];
        let guard = 0;
        while (len > 1e-9 && guard++ < 10000) {
          if (left >= len) {
            left -= len;
            if (on) piece.push(bx, by);
            break;
          }
          const k = left / len;
          const mx = ax + (bx - ax) * k, my = ay + (by - ay) * k;
          if (on) { piece.push(mx, my); this._polyline(piece, false, hw, col); }
          on = !on;
          piece = [mx, my];
          ax = mx; ay = my; len -= left;
          di = (di + 1) % D.length; left = D[di];
        }
      }
      if (on && piece.length >= 4) this._polyline(piece, false, hw, col);
    }

    _polyline(raw, closed, hw, col) {
      const p = [raw[0], raw[1]];
      for (let i = 2; i < raw.length; i += 2) {
        const x = raw[i], y = raw[i + 1];
        if (Math.abs(x - p[p.length - 2]) > 1e-3 || Math.abs(y - p[p.length - 1]) > 1e-3) p.push(x, y);
      }
      if (closed && p.length > 4 && Math.abs(p[0] - p[p.length - 2]) < 1e-3 && Math.abs(p[1] - p[p.length - 1]) < 1e-3) p.length -= 2;
      const n = p.length >> 1;
      if (n < 2) return;
      if (n === 2) closed = false;
      const L = new Float64Array(n * 2), R = new Float64Array(n * 2);
      const nx = new Float64Array(n), ny = new Float64Array(n);
      const segs = closed ? n : n - 1;
      for (let i = 0; i < segs; i++) {
        const j = (i + 1) % n, dx = p[j * 2] - p[i * 2], dy = p[j * 2 + 1] - p[i * 2 + 1], l = Math.hypot(dx, dy) || 1;
        nx[i] = -dy / l; ny[i] = dx / l;
      }
      for (let i = 0; i < n; i++) {
        let mx, my, k = hw;
        const hasPrev = closed || i > 0, hasNext = closed || i < n - 1;
        if (hasPrev && hasNext) {
          const pi = (i - 1 + n) % n;
          mx = nx[pi] + nx[i]; my = ny[pi] + ny[i];
          const ml = Math.hypot(mx, my);
          if (ml < 1e-6) { mx = nx[i]; my = ny[i]; }
          else {
            mx /= ml; my /= ml;
            k = hw / Math.max(mx * nx[i] + my * ny[i], 0.25);
          }
        } else if (hasNext) { mx = nx[i]; my = ny[i]; }
        else { mx = nx[i - 1]; my = ny[i - 1]; }
        L[i * 2] = p[i * 2] + mx * k; L[i * 2 + 1] = p[i * 2 + 1] + my * k;
        R[i * 2] = p[i * 2] - mx * k; R[i * 2 + 1] = p[i * 2 + 1] - my * k;
      }
      this._prep(segs * 6);
      for (let i = 0; i < segs; i++) {
        const j = (i + 1) % n;
        this._quad(L[i * 2], L[i * 2 + 1], L[j * 2], L[j * 2 + 1], R[j * 2], R[j * 2 + 1], R[i * 2], R[i * 2 + 1],
                   0.5, 0.5, 0.5, 0.5, col, 0);
      }
    }

    // ---------------- degradados y textos ----------------

    createLinearGradient(x0, y0, x1, y1) { return new Grad('linear', x0, y0, 0, x1, y1, 0); }
    createRadialGradient(x0, y0, r0, x1, y1, r1) { return new Grad('radial', x0, y0, r0, x1, y1, r1); }
    createPattern() { return null; }

    measureText(s) {
      this.sctx.font = this._font;
      return this.sctx.measureText(s);
    }

    fillText(s, x, y) { this._text(String(s), x, y, false); }
    strokeText(s, x, y) { this._text(String(s), x, y, true); }

    _resetAtlas() {
      this.flush();
      this.texts.clear();
      this.shelfX = this.shelfY = this.shelfH = 0;
    }

    _text(s, x, y, stroke) {
      const al = this._alpha;
      if (al <= 0 || !s) return;
      const sc = this._scale();
      if (!sc) return;
      const S = Math.max(0.25, Math.round(sc * 4) / 4);
      const style = stroke ? this._stroke : this._fill;
      let css = stroke ? this._strokeRaw : this._fillRaw;
      if (style instanceof Grad) { const m = style.mid(); css = `rgba(${Math.round(m[0])},${Math.round(m[1])},${Math.round(m[2])},${m[3]})`; }
      const lw = stroke ? this._lw : 0;
      // El idioma va en la clave: i18n.js traduce dentro de fillText del canvas de apoyo (sctx).
      const key = S + '|' + document.documentElement.lang + '|' + this._font + '|' + this._baseline + '|' + (stroke ? 's' + lw + this._join : 'f') + '|' + css + '|' + s;
      let t = this.texts.get(key);
      if (!t) {
        t = this._rasterText(s, S, css, stroke, lw);
        if (!t) return;
        this.texts.set(key, t);
      }
      const ta = this._align;
      const ox = t.ox + (ta === 'center' ? t.tw / 2 : ta === 'right' || ta === 'end' ? t.tw : 0);
      const ux = x - ox / S, uy = y - t.oy / S, uw = t.w / S, uh = t.h / S;
      this._prep(6);
      const ti = this._slot(this.atlas);
      const col = grey(al);
      const a = this.a, b = this.b, c = this.c, d = this.d;
      const x0 = a * ux + c * uy + this.e, y0 = b * ux + d * uy + this.f;
      const wx = a * uw, wy = b * uw, hx = c * uh, hy = d * uh;
      const AS = this.atlasSize;
      this._quad(x0, y0, x0 + wx, y0 + wy, x0 + wx + hx, y0 + wy + hy, x0 + hx, y0 + hy,
                 t.x / AS, t.y / AS, (t.x + t.w) / AS, (t.y + t.h) / AS, col, ti);
    }

    _rasterText(s, S, css, stroke, lw) {
      const c = this.sctx, cv = this.scratch;
      const pm = /(\d*\.?\d+)px/.exec(this._font);
      const px = (pm ? parseFloat(pm[1]) : 10) * S;
      const font = pm ? this._font.replace(pm[0], px + 'px') : this._font;
      c.font = font; c.textAlign = 'left'; c.textBaseline = this._baseline;
      const m = c.measureText(s);
      const pad = Math.ceil(lw * S / 2) + 2;
      const left = Math.max(0, m.actualBoundingBoxLeft || 0), right = Math.max(m.width, m.actualBoundingBoxRight || 0);
      const asc = Math.max(0, m.actualBoundingBoxAscent != null ? m.actualBoundingBoxAscent : px * 0.8);
      const desc = Math.max(0, m.actualBoundingBoxDescent != null ? m.actualBoundingBoxDescent : px * 0.25);
      const W = Math.ceil(left + right) + pad * 2, H = Math.ceil(asc + desc) + pad * 2;
      const AS = this.atlasSize;
      if (!(W > 0 && H > 0) || W > AS || H > AS) return null;
      if (this.shelfX + W + 1 > AS) { this.shelfY += this.shelfH + 1; this.shelfX = 0; this.shelfH = 0; }
      if (this.shelfY + H + 1 > AS) this._resetAtlas();
      const ax = this.shelfX, ay = this.shelfY;
      this.shelfX += W + 1; this.shelfH = Math.max(this.shelfH, H);
      cv.width = W; cv.height = H;
      c.font = font; c.textAlign = 'left'; c.textBaseline = this._baseline;
      const x0 = pad + left, y0 = pad + asc;
      if (stroke) {
        c.lineWidth = lw * S; c.lineJoin = this._join; c.strokeStyle = css;
        c.strokeText(s, x0, y0);
      } else {
        c.fillStyle = css;
        c.fillText(s, x0, y0);
      }
      // Sólo se escribe una zona nueva del atlas: lo ya encolado sigue valiendo (flush() vuelve a poner cada unidad).
      this._bind0(this.atlas);
      this.gl.texSubImage2D(this.gl.TEXTURE_2D, 0, ax, ay, this.gl.RGBA, this.gl.UNSIGNED_BYTE, cv);
      return { x: ax, y: ay, w: W, h: H, ox: x0, oy: y0, tw: m.width };
    }
  }

  function wanted() {
    const m = /[?&]renderer=(\w+)/.exec(location.search);
    return m ? m[1].toLowerCase() !== 'canvas' : true;
  }

  function create(overlay) {
    try { return new GLCtx(overlay); }
    catch (e) { console.warn('[WebGL] no disponible, se usa el canvas 2D:', e.message); return null; }
  }

  return { wanted, create, Grad, parseColor };
})();
