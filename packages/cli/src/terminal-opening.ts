import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { TerminalTheme } from "./terminal-style.js";

type Vector = readonly [number, number, number];
interface SurfacePoint { position: Vector; normal: Vector; texture: number }
let surface: readonly SurfacePoint[] | undefined;

/** A beveled, extruded R with an inset contour on both faces. */
function letterSurface(): readonly SurfacePoint[] {
  if (surface !== undefined) return surface;
  const inside = (x: number, y: number): boolean => {
    const stem = x >= -1.15 && x <= -.62 && y >= -1.5 && y <= 1.5;
    const outer = Math.max(0, Math.abs(x + .1) - .65) ** 2 + Math.max(0, Math.abs(y + .7) - .4) ** 2 <= .4 ** 2;
    const inner = Math.max(0, Math.abs(x + .05) - .4) ** 2 + Math.max(0, Math.abs(y + .7) - .12) ** 2 < .16 ** 2;
    const bowl = outer && !inner;
    const leg = y >= -.08 && y <= 1.5 && Math.abs(x - .69 * y + .16) <= .3;
    return stem || bowl || leg;
  };
  const points: SurfacePoint[] = [];
  for (let y = -1.5; y <= 1.5; y += .025) {
    for (let x = -1.4; x <= 1.4; x += .025) {
      if (!inside(x, y)) continue;
      const nearEdge = (distance: number): boolean => !inside(x + distance, y) || !inside(x - distance, y) || !inside(x, y + distance) || !inside(x, y - distance);
      const bevel = nearEdge(.075);
      const nx = Number(inside(x - .08, y)) - Number(inside(x + .08, y));
      const ny = Number(inside(x, y - .08)) - Number(inside(x, y + .08));
      const length = Math.hypot(nx, ny) || 1;
      const texture = !bevel && nearEdge(.14) ? .4 : 1;
      for (const side of [-1, 1]) points.push({
        position: [x, y, side * (bevel ? .25 : .32)],
        normal: bevel ? [nx / length * .65, ny / length * .65, side * .76] : [0, 0, side], texture,
      });
      if (nearEdge(.03)) for (let z = -.25; z <= .25; z += .025) points.push({
        position: [x, y, z], normal: [nx / length, ny / length, 0], texture: 1,
      });
    }
  }
  surface = points;
  return surface;
}

/** Uses the same normal-based ASCII lighting as the original 3D design preview. */
export function renderTerminalOpening(width: number, available: number, theme: TerminalTheme, frame = 0): string[] {
  if (available < 5) return [];
  const center = (value: string): string => {
    const text = truncateToWidth(value, Math.max(1, width), "", false);
    return " ".repeat(Math.max(0, Math.floor((width - visibleWidth(text)) / 2))) + text;
  };
  const rows: string[] = [];
  if (available >= 12 && width >= 40 && theme.colorEnabled) {
    const artHeight = Math.min(20, available - 6);
    const artWidth = Math.min(64, width);
    const cells = Array.from({ length: artHeight }, () => Array.from({ length: artWidth }, () => ({ ch: " ", light: 0 })));
    const depth = Array.from({ length: artHeight }, () => Array<number>(artWidth).fill(-Infinity));
    const scale = Math.min(artWidth / 9, artHeight / 4.3);
    const time = frame * .08;
    const ay = time * 1.2 + .4, ax = .38 + Math.sin(time * .27) * .16;
    const cy = Math.cos(ay), sy = Math.sin(ay), cx = Math.cos(ax), sx = Math.sin(ax);
    const rotate = ([x, y, z]: Vector): Vector => {
      const a = x * cy + z * sy, b = -x * sy + z * cy;
      return [a, y * cx - b * sx, y * sx + b * cx];
    };
    const shades = " .,:;irsXA253hMHGS#9B&@";
    for (const point of letterSurface()) {
      const q = rotate(point.position), normal = rotate(point.normal), perspective = 8 / (8 - q[2]);
      const x = Math.round((artWidth - 1) / 2 + q[0] * scale * 2 * perspective);
      const y = Math.round((artHeight - 1) / 2 + q[1] * scale * perspective);
      if (x < 0 || x >= artWidth || y < 0 || y >= artHeight || q[2] <= depth[y]![x]!) continue;
      depth[y]![x] = q[2];
      const diffuse = Math.max(0, normal[0] * -.35 + normal[1] * -.55 + normal[2] * .76);
      const specular = Math.pow(Math.max(0, normal[0] * -.15 + normal[1] * -.24 + normal[2] * .96), 16);
      const light = Math.min(1, (.16 + .68 * diffuse + .3 * specular) * point.texture);
      cells[y]![x] = { ch: shades[Math.max(1, Math.floor(light * (shades.length - 1)))]!, light };
    }
    rows.push(...cells.map((row) => {
      let result = "", run = "", role = 0;
      const style = (text: string, value: number): string => value === 2 ? theme.strong(text) : value === 1 ? theme.accent(text) : theme.muted(text);
      for (const { ch, light } of row) {
        const next = light > .77 ? 2 : light > .36 ? 1 : 0;
        if (next !== role) { result += style(run, role); run = ""; role = next; }
        run += ch;
      }
      return center(result + style(run, role));
    }), "");
  }
  rows.push(...[
    "█▀▄ █▀▀ █▀▀ █ █ █▀▄ █▀▀",
    "█▀▄ █▀▀ █   █ █ █▀▄ ▀▀█",
    "▀ ▀ ▀▀▀ ▀▀▀ ▀▀▀ ▀ ▀ ▀▀▀",
  ].map((line) => theme.accent(center(line))), "", theme.muted(center("One task. A team you control.")));
  return rows.slice(0, available);
}
