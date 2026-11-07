import * as THREE from 'three';
import { CSS3DObject, CSS3DRenderer } from 'three/addons/renderers/CSS3DRenderer.js';

/**
 * The 3D "trading desk": a curved, two-tier bank of equal feed monitors around the viewer's seat.
 *
 *   top row     [ main   ] [ side-1 ]
 *   bottom row  [ side-2 ] [ side-3 ]
 *                \______ desk ______/
 *
 * WebGL draws the architecture (desk, bezels, stands, light); the screens themselves are real DOM
 * (CSS3D) so video, buttons and text stay native and crisp. Both share one perspective camera.
 */

export type MonitorId = 'main' | 'side-1' | 'side-2' | 'side-3';

export interface MonitorPose {
  id: MonitorId;
  width: number;
  height: number;
  row: 0 | 1;
  col: 0 | 1;
  position: THREE.Vector3;
  quaternion: THREE.Quaternion;
  normal: THREE.Vector3;
}

/** Feed tiles are always laid out at this CSS size and scaled to their monitor. */
export const TILE_W = 1280;
export const TILE_H = 720;
const RADIUS = 2300;
const GAP = 44;
const DESK_Y = -TILE_H / 2 - 70;
const TOP_Y = TILE_H + 60;
const TOP_PITCH = 0.08;

export type RoomTheme = 'light' | 'dark';

/** Room materials per app theme: brand ink/paper neutrals, lime as the only accent. */
const PALETTES = {
  dark: {
    clear: '#101210',
    sky: '#f7f8f4',
    ground: '#101210',
    hemi: 1.5,
    key: 1.2,
    floor: '#131513',
    gridMajor: '#262a24',
    gridMinor: '#1a1d19',
    desk: '#1d201c',
    lip: '#171917',
    keyboard: '#2b3029',
    slat: '#3a4037',
    slatOpacity: 0.3,
    frame: '#171917',
    back: '#141614',
    pole: '#222620',
    metalness: 0.6,
    edgeOpacity: 0.7,
    blending: THREE.AdditiveBlending,
  },
  light: {
    clear: '#f7f8f4',
    sky: '#ffffff',
    ground: '#c6ccbf',
    hemi: 2.4,
    key: 1.1,
    floor: '#eef0ea',
    gridMajor: '#d4d9cd',
    gridMinor: '#e4e8de',
    desk: '#e4e8de',
    lip: '#c6ccbf',
    keyboard: '#d0d5c9',
    slat: '#c6ccbf',
    slatOpacity: 0.45,
    frame: '#171917',
    back: '#2b3029',
    pole: '#c6ccbf',
    metalness: 0.1,
    edgeOpacity: 0.95,
    blending: THREE.NormalBlending,
  },
} as const;

function row(ids: [MonitorId, MonitorId], y: number, pitch: number, rowIndex: 0 | 1): MonitorPose[] {
  const half = Math.asin(TILE_W / 2 / RADIUS);
  const gap = 2 * Math.asin(GAP / 2 / RADIUS);
  const thetas = [-(half + gap / 2), half + gap / 2];
  return ids.map((id, i) => {
    const theta = thetas[i]!;
    const d = RADIUS * Math.cos(half);
    const quaternion = new THREE.Quaternion().setFromEuler(new THREE.Euler(pitch, -theta, 0, 'YXZ'));
    return {
      id,
      width: TILE_W,
      height: TILE_H,
      row: rowIndex,
      col: i as 0 | 1,
      position: new THREE.Vector3(d * Math.sin(theta), y, -d * Math.cos(theta)),
      quaternion,
      normal: new THREE.Vector3(0, 0, 1).applyQuaternion(quaternion),
    };
  });
}

export const MONITORS: Record<MonitorId, MonitorPose> = Object.fromEntries(
  [...row(['main', 'side-1'], TOP_Y, TOP_PITCH, 0), ...row(['side-2', 'side-3'], 0, 0, 1)].map((m) => [m.id, m]),
) as Record<MonitorId, MonitorPose>;

function glowTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d')!;
  const grad = g.createRadialGradient(64, 64, 0, 64, 64, 64);
  grad.addColorStop(0, 'rgba(255,255,255,1)');
  grad.addColorStop(0.35, 'rgba(255,255,255,0.35)');
  grad.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 128, 128);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

interface Placed {
  object: CSS3DObject;
  monitor: MonitorId;
  /** An in-flight move between monitors. */
  flight: { from: THREE.Vector3; fromQ: THREE.Quaternion; fromS: number; start: number; lift: number } | null;
}

const FLIGHT_MS = 750;
const ease = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);

interface Heat {
  glow: number;
  hot: boolean;
  /** Smoothed values actually drawn. */
  shown: number;
}

export function createSpatialRoom(
  host: HTMLElement,
  reducedMotion: boolean,
  onLost: () => void,
  theme: RoomTheme = 'dark',
) {
  const LIME = new THREE.Color(getComputedStyle(host).getPropertyValue('--accent').trim() || '#c5ff00');
  const HOT = LIME;
  const P = PALETTES[theme];
  const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'low-power' });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 1.5));
  renderer.setClearColor(P.clear);
  const css = new CSS3DRenderer();
  css.domElement.style.position = 'absolute';
  css.domElement.style.inset = '0';
  host.append(renderer.domElement, css.domElement);

  const scene = new THREE.Scene();
  scene.fog = new THREE.Fog(P.clear, 2600, 7600);
  const surfaces = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(45, 1, 10, 14000);

  scene.add(new THREE.HemisphereLight(P.sky, P.ground, P.hemi));
  const key = new THREE.DirectionalLight('#ffffff', P.key);
  key.position.set(400, 2400, 1600);
  scene.add(key);

  const disposables: { dispose(): void }[] = [];
  const track = <T extends { dispose(): void }>(d: T) => (disposables.push(d), d);

  // Floor far below the desk, fading into fog.
  const floor = new THREE.Mesh(
    track(new THREE.PlaneGeometry(24000, 24000)),
    track(new THREE.MeshStandardMaterial({ color: P.floor, roughness: 0.6, metalness: P.metalness })),
  );
  floor.rotation.x = -Math.PI / 2;
  floor.position.y = -1250;
  scene.add(floor);
  const grid = new THREE.GridHelper(16000, 64, P.gridMajor, P.gridMinor);
  grid.position.y = -1248;
  scene.add(grid);
  track(grid.geometry);
  track(grid.material as THREE.Material);

  // The curved desk: a ring segment with a front lip and a lime edge light.
  const span = 0.9;
  const deskMat = track(
    new THREE.MeshStandardMaterial({ color: P.desk, roughness: 0.4, metalness: P.metalness, side: THREE.DoubleSide }),
  );
  const desk = new THREE.Mesh(track(new THREE.RingGeometry(1150, 2180, 120, 1, Math.PI / 2 - span, span * 2)), deskMat);
  desk.rotation.x = -Math.PI / 2;
  desk.position.y = DESK_Y;
  scene.add(desk);
  const lip = new THREE.Mesh(
    track(new THREE.CylinderGeometry(1150, 1150, 46, 120, 1, true, Math.PI - span, span * 2)),
    track(new THREE.MeshStandardMaterial({ color: P.lip, roughness: 0.5, metalness: P.metalness, side: THREE.DoubleSide })),
  );
  lip.position.y = DESK_Y - 23;
  scene.add(lip);
  const edgeMat = track(new THREE.MeshBasicMaterial({ color: LIME, transparent: true, opacity: P.edgeOpacity }));
  const edge = new THREE.Mesh(track(new THREE.RingGeometry(1150, 1157, 120, 1, Math.PI / 2 - span, span * 2)), edgeMat);
  edge.rotation.x = -Math.PI / 2;
  edge.position.y = DESK_Y + 1;
  scene.add(edge);

  // A keyboard on the desk, with a faint underglow — sells the scale.
  const keyboard = new THREE.Mesh(
    track(new THREE.BoxGeometry(620, 14, 190)),
    track(new THREE.MeshStandardMaterial({ color: P.keyboard, roughness: 0.6, metalness: P.metalness })),
  );
  keyboard.position.set(0, DESK_Y + 9, -1420);
  scene.add(keyboard);

  const glowTex = track(glowTexture());
  const pool = (w: number, d: number, color: THREE.ColorRepresentation, opacity: number) => {
    const m = new THREE.Mesh(
      track(new THREE.PlaneGeometry(w, d)),
      track(
        new THREE.MeshBasicMaterial({
          map: glowTex,
          color,
          transparent: true,
          opacity,
          blending: P.blending,
          depthWrite: false,
        }),
      ),
    );
    m.rotation.x = -Math.PI / 2;
    return m;
  };
  const kbGlow = pool(900, 380, LIME, 0.12);
  kbGlow.position.set(0, DESK_Y + 2, -1420);
  scene.add(kbGlow);

  // Distant vertical light slats behind the wall give depth without stealing attention.
  for (let i = -6; i <= 6; i++) {
    const a = i * 0.16;
    const slat = new THREE.Mesh(
      track(new THREE.PlaneGeometry(10, 3000)),
      track(new THREE.MeshBasicMaterial({ color: P.slat, transparent: true, opacity: P.slatOpacity - Math.abs(i) * 0.02 })),
    );
    slat.position.set(Math.sin(a) * 3900, 300, -Math.cos(a) * 3900);
    slat.rotation.y = -a;
    scene.add(slat);
  }

  // Monitors: bezel, stand, status light bar and (bottom row) a light pool on the desk.
  const fixtures = new Map<MonitorId, { pool: THREE.MeshBasicMaterial | null; frame: THREE.MeshStandardMaterial }>();
  for (const m of Object.values(MONITORS)) {
    const g = new THREE.Group();
    g.position.copy(m.position);
    g.quaternion.copy(m.quaternion);
    const frame = track(
      new THREE.MeshStandardMaterial({ color: P.frame, roughness: 0.45, metalness: 0.5, emissive: '#000000' }),
    );
    const bezel = new THREE.Mesh(track(new THREE.BoxGeometry(m.width + 26, m.height + 26, 34)), frame);
    bezel.position.z = -19;
    g.add(bezel);
    const back = new THREE.Mesh(
      track(new THREE.BoxGeometry(m.width * 0.4, m.height * 0.4, 50)),
      track(new THREE.MeshStandardMaterial({ color: P.back, roughness: 0.6, metalness: 0.5 })),
    );
    back.position.z = -60;
    g.add(back);
    scene.add(g);

    let poolMat: THREE.MeshBasicMaterial | null = null;
    if (m.row === 1) {
      // Pole from the desk up to the top-row monitor in the same column.
      const pole = new THREE.Mesh(
        track(new THREE.BoxGeometry(46, TOP_Y - DESK_Y, 46)),
        track(new THREE.MeshStandardMaterial({ color: P.pole, roughness: 0.4, metalness: P.metalness })),
      );
      pole.position.set(m.position.x * 1.04, (TOP_Y + DESK_Y) / 2, m.position.z * 1.04);
      scene.add(pole);
      const p = pool(m.width * 1.5, 900, LIME, 0);
      p.position.set(m.position.x * 0.86, DESK_Y + 2, m.position.z * 0.86);
      p.rotation.z = Math.atan2(m.normal.x, m.normal.z);
      scene.add(p);
      poolMat = p.material as THREE.MeshBasicMaterial;
    }
    fixtures.set(m.id, { pool: poolMat, frame });
  }

  // ── Camera rig ────────────────────────────────────────────────────────────────────────────
  const goalPos = new THREE.Vector3();
  const goalLook = new THREE.Vector3();
  const pos = new THREE.Vector3();
  const look = new THREE.Vector3();
  const pointer = new THREE.Vector2();
  const smoothPointer = new THREE.Vector2();
  let focused: MonitorId | null = null;
  let hovered: MonitorId | null = null;
  const pending = new Set<MonitorId>();
  let first = true;

  const fov = () => {
    const tanV = Math.tan(THREE.MathUtils.degToRad(camera.fov / 2));
    return { tanV, tanH: tanV * camera.aspect };
  };
  /** Screen bounds: local vertical centre and corners. */
  const stackMid = (m: MonitorPose) => m.height / 2 - (TILE_H + 26) / 2;
  const corners = (m: MonitorPose) =>
    [-1, 1].flatMap((sx) =>
      [-1, 1].map((sy) =>
        new THREE.Vector3((sx * (m.width + 26)) / 2, stackMid(m) + (sy * (TILE_H + 26)) / 2, 0)
          .applyQuaternion(m.quaternion)
          .add(m.position),
      ),
    );

  const aim = () => {
    const { tanV, tanH } = fov();
    if (focused === null) {
      // Back far enough that the whole wall fits, leaving room for the HUD above and below.
      const pts = Object.values(MONITORS).flatMap(corners);
      const minY = Math.min(...pts.map((p) => p.y));
      const maxY = Math.max(...pts.map((p) => p.y));
      const cy = (minY + maxY) / 2;
      let z = 0;
      for (const p of pts) {
        z = Math.max(z, p.z + Math.abs(p.x) / (tanH * 0.97), p.z + Math.abs(p.y - cy) / (tanV * 0.84));
      }
      goalPos.set(0, cy + 40, z);
      goalLook.set(0, cy - 10, -RADIUS);
    } else {
      const m = MONITORS[focused];
      // Fill the space between the top bar and the dock with the screen.
      const d = Math.max((TILE_H + 26) / 2 / (tanV * 0.82), m.width / 2 / (tanH * 0.9));
      goalLook.copy(m.position).add(new THREE.Vector3(0, stackMid(m) + 10, 0).applyQuaternion(m.quaternion));
      goalPos.copy(m.position).addScaledVector(m.normal, d);
    }
    if (first || reducedMotion) {
      pos.copy(goalPos);
      look.copy(goalLook);
      first = false;
    }
  };

  const resize = () => {
    const { width, height } = host.getBoundingClientRect();
    if (!width || !height) return;
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
    renderer.setSize(width, height);
    css.setSize(width, height);
    aim();
  };
  resize();
  const observer = new ResizeObserver(resize);
  observer.observe(host);

  const contextLost = (event: Event) => {
    event.preventDefault();
    onLost();
  };
  renderer.domElement.addEventListener('webglcontextlost', contextLost);

  // ── Surfaces & heat ───────────────────────────────────────────────────────────────────────
  const placed = new Map<string, Placed>();
  const heat = new Map<MonitorId, Heat>();
  const offset = (m: MonitorPose) => m.position.clone().addScaledVector(m.normal, 1);

  const tmpColor = new THREE.Color();
  let disposed = false;
  let previous = performance.now();
  let clock = 0;
  renderer.setAnimationLoop((time) => {
    if (disposed || document.hidden) return;
    // Generous cap so a throttled tab still lands its camera moves on time.
    const dt = Math.min((time - previous) / 1000, 0.25);
    previous = time;
    clock += dt;
    const k = reducedMotion ? 1 : 1 - Math.exp(-dt * 5.5);
    const kp = 1 - Math.exp(-dt * 3);

    // Gentle head-movement parallax in the overview; rock steady when focused (crisp text).
    smoothPointer.lerp(focused === null && !reducedMotion ? pointer : new THREE.Vector2(), kp);
    const right = new THREE.Vector3(1, 0, 0);
    const parallax = right.multiplyScalar(smoothPointer.x * 160).add(new THREE.Vector3(0, -smoothPointer.y * 70, 0));
    pos.lerp(goalPos.clone().add(parallax), k);
    look.lerp(goalLook, k);
    camera.position.copy(pos);
    camera.lookAt(look);

    for (const p of placed.values()) {
      const m = MONITORS[p.monitor];
      const s = m.width / (p.object.element.offsetWidth || m.width);
      const f = p.flight;
      if (!f || reducedMotion) {
        p.object.position.copy(offset(m));
        p.object.quaternion.copy(m.quaternion);
        p.object.scale.setScalar(s);
        p.flight = null;
        continue;
      }
      // Arc between monitors: the screen swings out toward you so it never slices through another.
      const t = Math.min(1, (time - f.start) / FLIGHT_MS);
      const e = ease(t);
      p.object.position
        .lerpVectors(f.from, offset(m), e)
        .addScaledVector(m.normal, Math.sin(Math.PI * t) * f.lift);
      p.object.quaternion.slerpQuaternions(f.fromQ, m.quaternion, e);
      p.object.scale.setScalar(f.fromS + (s - f.fromS) * e);
      if (t >= 1) p.flight = null;
    }

    for (const [id, f] of fixtures) {
      const h = heat.get(id);
      const target = h?.glow ?? 0;
      if (h) h.shown += (target - h.shown) * kp;
      const g = h?.shown ?? 0;
      const pulse = h?.hot ? 0.75 + 0.25 * Math.sin(clock * 6) : 1;
      if (pending.has(id)) {
        // About to switch: the whole bezel throbs lime so it reads from across the room.
        const beat = 0.5 + 0.5 * Math.sin(clock * 7);
        tmpColor.copy(LIME).multiplyScalar(0.25 + 0.45 * beat);
        f.frame.emissive.lerp(tmpColor, k);
        if (f.pool) {
          f.pool.color.copy(LIME);
          f.pool.opacity = 0.2 + 0.35 * beat;
        }
        continue;
      }
      tmpColor.copy(HOT).multiplyScalar(g * 0.18 * pulse);
      f.frame.emissive.lerp(tmpColor, k);
      if (f.pool) {
        f.pool.color.copy(g > 0.02 ? HOT : LIME);
        f.pool.opacity = (id === focused ? 0.16 : 0.05) + g * 0.45 * pulse;
      }
    }
    edgeMat.opacity = 0.55 + 0.25 * Math.sin(clock * 0.8);

    renderer.render(scene, camera);
    css.render(surfaces, camera);
  });

  return {
    focus(id: MonitorId | null) {
      focused = id;
      aim();
    },
    setHover(id: MonitorId | null) {
      hovered = id;
    },
    /** Normalised pointer position in the viewport, -1…1. */
    setPointer(x: number, y: number) {
      pointer.set(x, y);
    },
    setPending(id: MonitorId, on: boolean) {
      if (on) pending.add(id);
      else pending.delete(id);
    },
    setHeat(id: MonitorId, glow: number, hot: boolean) {
      const h = heat.get(id);
      if (h) {
        h.glow = glow;
        h.hot = hot;
      } else heat.set(id, { glow, hot, shown: glow });
    },
    /** Put a DOM surface on a monitor (scaled to fill its width). */
    place(key: string, element: HTMLElement, monitor: MonitorId) {
      const object = new CSS3DObject(element);
      const m = MONITORS[monitor];
      object.position.copy(offset(m));
      object.quaternion.copy(m.quaternion);
      const s = m.width / (element.offsetWidth || parseFloat(element.style.width) || m.width);
      object.scale.setScalar(s);
      surfaces.add(object);
      placed.set(key, { object, monitor, flight: null });
    },
    /** Glide a surface to another monitor (the element — and its video — is kept). */
    move(key: string, monitor: MonitorId) {
      const p = placed.get(key);
      if (!p || p.monitor === monitor) return;
      p.flight = {
        from: p.object.position.clone(),
        fromQ: p.object.quaternion.clone(),
        fromS: p.object.scale.x,
        start: performance.now(),
        lift: 260,
      };
      p.monitor = monitor;
    },
    remove(key: string) {
      const p = placed.get(key);
      if (p) surfaces.remove(p.object);
      placed.delete(key);
    },
    dispose() {
      disposed = true;
      observer.disconnect();
      renderer.setAnimationLoop(null);
      renderer.domElement.removeEventListener('webglcontextlost', contextLost);
      disposables.forEach((d) => d.dispose());
      placed.forEach((p) => surfaces.remove(p.object));
      renderer.dispose();
      renderer.domElement.remove();
      css.domElement.remove();
    },
  };
}

export type SpatialRoom = ReturnType<typeof createSpatialRoom>;
