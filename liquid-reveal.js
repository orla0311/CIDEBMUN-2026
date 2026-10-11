// <liquid-reveal logo="..." photo="..."> — mouse-driven metaball liquid mask.
// The logo is the top layer; moving the cursor over it melts the liquid and
// reveals the photograph behind. Leaving recomposes it.
(function () {
  if (customElements.get('liquid-reveal')) return;

  const VERT = `
    attribute vec2 aPos;
    void main() { gl_Position = vec4(aPos, 0.0, 1.0); }
  `;

  const FRAG = `
    precision highp float;

    #define TRAIL 12

    uniform vec2  uRes;
    uniform float uTime;
    uniform float uReveal;
    uniform float uDpr;
    uniform vec3  uTrail[TRAIL];   // x, y (device px), age 0..1
    uniform sampler2D uLogo;
    uniform sampler2D uPhoto;
    uniform vec2  uLogoSize;
    uniform vec2  uPhotoSize;
    uniform vec3  uBg;

    float hash(vec2 p) {
      return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
    }
    float noise(vec2 p) {
      vec2 i = floor(p), f = fract(p);
      f = f * f * (3.0 - 2.0 * f);
      return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), f.x),
                 mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), f.x), f.y);
    }
    float fbm(vec2 p) {
      return 0.55 * noise(p) + 0.28 * noise(p * 2.03) + 0.17 * noise(p * 4.11);
    }

    // whole texture visible, letterboxed
    vec2 containUV(vec2 uv, vec2 texSize) {
      float ra = uRes.x / uRes.y;
      float ta = texSize.x / texSize.y;
      vec2 s = (ra > ta) ? vec2(ra / ta, 1.0) : vec2(1.0, ta / ra);
      return (uv - 0.5) * s + 0.5;
    }
    // texture fills the frame, cropped
    vec2 coverUV(vec2 uv, vec2 texSize) {
      float ra = uRes.x / uRes.y;
      float ta = texSize.x / texSize.y;
      vec2 s = (ra > ta) ? vec2(1.0, ta / ra) : vec2(ra / ta, 1.0);
      return (uv - 0.5) * s + 0.5;
    }

    void main() {
      vec2 frag = gl_FragCoord.xy;
      vec2 uv = frag / uRes;
      float R = min(uRes.x, uRes.y) * 0.075;

      // metaball field + its gradient, from the cursor trail
      float f = 0.0;
      vec2  grad = vec2(0.0);
      for (int i = 0; i < TRAIL; i++) {
        float age = uTrail[i].z;
        if (age <= 0.001) continue;
        vec2 d = frag - uTrail[i].xy;
        float dn = length(d) / R;
        float c = age / (1.0 + 6.0 * dn * dn);
        f += c;
        grad += (dn > 0.0001 ? normalize(d) : vec2(0.0)) * c;
      }

      // organic wobble so edges read as liquid, not as a radial fade
      float n = fbm(uv * 4.2 + vec2(uTime * 0.13, uTime * -0.09));
      f *= 0.72 + 0.62 * n;
      f *= uReveal;

      float mask = smoothstep(0.30, 0.92, f);

      // displacement: liquid pulls the surface toward the cursor and ripples
      float ripple = sin(f * 9.0 - uTime * 2.2) * 0.5 + 0.5;
      vec2 disp = -grad * (0.004 * uReveal) * (0.65 + 0.5 * ripple);
      disp += vec2(n - 0.5, fbm(uv * 3.1 - uTime * 0.11) - 0.5) * 0.004 * mask;
      // faint idle breathing keeps the surface alive at rest
      disp += vec2(sin(uv.y * 7.0 + uTime * 0.5), cos(uv.x * 6.0 - uTime * 0.42)) * 0.0022;

      // pull back a little so the whole group fits inside the reveal
      vec2 puv = (uv - 0.5) * 1.34 + 0.5;
      vec4 photo = texture2D(uPhoto, coverUV(puv + disp * 0.16, uPhotoSize));

      vec2 luv = containUV(uv + disp, uLogoSize);
      vec4 logoTex = texture2D(uLogo, luv);
      float inside = step(0.0, luv.x) * step(luv.x, 1.0) * step(0.0, luv.y) * step(luv.y, 1.0);
      float logoA = max(max(logoTex.r, logoTex.g), logoTex.b) * inside;
      // melt: the mark thins out where the liquid has opened
      logoA *= 1.0 - mask * 0.88;

      vec3 col = mix(uBg, photo.rgb, mask);
      // specular sheen along the liquid rim
      float rim = smoothstep(0.42, 0.62, f) * (1.0 - smoothstep(0.62, 0.98, f));
      col += rim * 0.03 * uReveal;
      col = mix(col, logoTex.rgb, logoA);

      gl_FragColor = vec4(col, 1.0);
    }
  `;

  const TRAIL = 12;

  function compile(gl, type, src) {
    const s = gl.createShader(type);
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
      throw new Error(gl.getShaderInfoLog(s) || 'shader compile failed');
    }
    return s;
  }

  function texture(gl, img) {
    const t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    return t;
  }

  function load(src) {
    return new Promise((res, rej) => {
      const i = new Image();
      i.crossOrigin = 'anonymous';
      i.onload = () => res(i);
      i.onerror = () => rej(new Error('image failed: ' + src));
      i.src = src;
    });
  }

  class LiquidReveal extends HTMLElement {
    connectedCallback() {
      if (this._booted) return;
      this._booted = true;

      const logoSrc = this.getAttribute('logo') || '';
      const photoSrc = this.getAttribute('photo') || '';
      const bg = this.getAttribute('background') || '#1b2733';

      this.style.display = 'block';
      this.style.position = 'relative';
      this.style.width = '100%';
      this.style.height = '100%';
      this.style.background = bg;
      this.style.cursor = 'crosshair';
      this.style.touchAction = 'none';

      const canvas = document.createElement('canvas');
      canvas.style.cssText = 'display:block;width:100%;height:100%;';
      this.appendChild(canvas);
      this._canvas = canvas;

      const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

      const gl = canvas.getContext('webgl', { antialias: false, alpha: false, powerPreference: 'high-performance' })
        || canvas.getContext('experimental-webgl');

      if (!gl || reduced) { this._fallback(logoSrc, bg); return; }
      this._gl = gl;

      let prog;
      try {
        prog = gl.createProgram();
        gl.attachShader(prog, compile(gl, gl.VERTEX_SHADER, VERT));
        gl.attachShader(prog, compile(gl, gl.FRAGMENT_SHADER, FRAG));
        gl.linkProgram(prog);
        if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
          throw new Error(gl.getProgramInfoLog(prog) || 'link failed');
        }
      } catch (e) {
        console.warn('[liquid-reveal]', e.message);
        this._fallback(logoSrc, bg);
        return;
      }
      gl.useProgram(prog);

      const buf = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, buf);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
      const aPos = gl.getAttribLocation(prog, 'aPos');
      gl.enableVertexAttribArray(aPos);
      gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);

      const u = n => gl.getUniformLocation(prog, n);
      const U = {
        res: u('uRes'), time: u('uTime'), reveal: u('uReveal'), dpr: u('uDpr'),
        trail: u('uTrail[0]'), logo: u('uLogo'), photo: u('uPhoto'),
        logoSize: u('uLogoSize'), photoSize: u('uPhotoSize'), bg: u('uBg')
      };

      const rgb = (hex) => {
        const h = hex.replace('#', '');
        const v = h.length === 3 ? h.split('').map(c => c + c).join('') : h;
        return [parseInt(v.slice(0, 2), 16) / 255, parseInt(v.slice(2, 4), 16) / 255, parseInt(v.slice(4, 6), 16) / 255];
      };
      gl.uniform3fv(U.bg, rgb(bg));

      // trail state
      const trail = new Float32Array(TRAIL * 3);
      let head = 0, reveal = 0, hovering = false, last = null, target = 0;

      const push = (x, y) => {
        head = (head + 1) % TRAIL;
        trail[head * 3] = x; trail[head * 3 + 1] = y; trail[head * 3 + 2] = 1;
      };

      const point = (ev) => {
        const r = canvas.getBoundingClientRect();
        const dpr = this._dpr || 1;
        const x = (ev.clientX - r.left) * dpr;
        const y = (r.height - (ev.clientY - r.top)) * dpr;
        if (last) {
          const d = Math.hypot(x - last[0], y - last[1]) / dpr;
          target = Math.min(1, target + d / 700);          // the more it moves, the more it melts
        }
        last = [x, y];
        push(x, y);
      };

      this.addEventListener('pointerenter', () => { hovering = true; });
      this.addEventListener('pointermove', (ev) => { hovering = true; point(ev); });
      this.addEventListener('pointerdown', (ev) => { hovering = true; target = Math.min(1, target + 0.35); point(ev); });
      this.addEventListener('pointerleave', () => { hovering = false; last = null; });

      const resize = () => {
        const dpr = Math.min(window.devicePixelRatio || 1, 2);
        this._dpr = dpr;
        const w = Math.max(1, Math.round(this.clientWidth * dpr));
        const h = Math.max(1, Math.round(this.clientHeight * dpr));
        if (canvas.width !== w || canvas.height !== h) {
          canvas.width = w; canvas.height = h;
          gl.viewport(0, 0, w, h);
          gl.uniform2f(U.res, w, h);
          gl.uniform1f(U.dpr, dpr);
        }
      };
      this._ro = new ResizeObserver(resize);
      this._ro.observe(this);

      Promise.all([load(logoSrc), load(photoSrc)]).then(([logo, photo]) => {
        gl.activeTexture(gl.TEXTURE0);
        texture(gl, logo);
        gl.uniform1i(U.logo, 0);
        gl.uniform2f(U.logoSize, logo.naturalWidth, logo.naturalHeight);

        gl.activeTexture(gl.TEXTURE1);
        texture(gl, photo);
        gl.uniform1i(U.photo, 1);
        gl.uniform2f(U.photoSize, photo.naturalWidth, photo.naturalHeight);

        resize();
        const t0 = performance.now();
        const frame = (t) => {
          this._raf = requestAnimationFrame(frame);
          if (!hovering) { target *= 0.90; }                 // recompose on leave
          reveal += (target - reveal) * 0.10;                // eased, never snapping
          for (let i = 0; i < TRAIL; i++) trail[i * 3 + 2] *= 0.945;
          if (hovering && last) push(last[0], last[1]);
          gl.uniform1f(U.time, (t - t0) / 1000);
          gl.uniform1f(U.reveal, Math.max(0, Math.min(1, reveal)));
          gl.uniform3fv(U.trail, trail);
          gl.drawArrays(gl.TRIANGLES, 0, 3);
        };
        this._raf = requestAnimationFrame(frame);
      }).catch(e => {
        console.warn('[liquid-reveal]', e.message);
        this._fallback(logoSrc, bg);
      });
    }

    _fallback(logoSrc, bg) {
      if (this._canvas) this._canvas.remove();
      this.style.cursor = 'default';
      this.style.background = bg;
      this.style.display = 'grid';
      this.style.placeItems = 'center';
      const img = document.createElement('img');
      img.src = logoSrc;
      img.alt = 'CIDEBMUN';
      img.style.cssText = 'max-width:min(72%,760px);height:auto;display:block;';
      this.appendChild(img);
    }

    disconnectedCallback() {
      if (this._raf) cancelAnimationFrame(this._raf);
      if (this._ro) this._ro.disconnect();
      const gl = this._gl;
      if (gl) { const e = gl.getExtension('WEBGL_lose_context'); if (e) e.loseContext(); }
      this._booted = false;
    }
  }

  customElements.define('liquid-reveal', LiquidReveal);
})();
