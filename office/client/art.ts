// Drawing: CC0 Kenney tiles for furniture and people, a few pixels of code-drawn props on top.
import { Application, Assets, Container, Graphics, Rectangle, Sprite, Texture } from "pixi.js";
import indoorUrl from "./assets/roguelikeIndoor_transparent.png";
import charUrl from "./assets/roguelikeChar_transparent.png";
import { CELL, ROOM, type Box, type RoomLayout } from "./layout.ts";
import { decodeLook } from "../people.ts";
import { DOOR, type DoorSlot } from "./lobby.ts";
import type { Pose } from "./pose.ts";

let indoor: Texture, chars: Texture;
export async function loadArt() {
  [indoor, chars] = await Promise.all([Assets.load<Texture>(indoorUrl), Assets.load<Texture>(charUrl)]);
  for (const t of [indoor, chars]) t.source.scaleMode = "nearest";
}

/** A pixel-crisp PixiJS canvas filling `host`. */
export async function newApp(host: HTMLElement) {
  const app = new Application();
  await app.init({
    background: COLORS.outside,
    antialias: false,
    roundPixels: true,
    resolution: window.devicePixelRatio || 1,
    autoDensity: true,
    width: host.clientWidth,
    height: host.clientHeight,
  });
  host.appendChild(app.canvas);
  app.canvas.style.imageRendering = "pixelated";
  return app;
}

// The Kenney sheets are 16px tiles with a 1px margin.
const tiles = new Map<string, Texture>();
function tile(sheet: Texture, c: number, r: number) {
  const key = `${sheet.uid}:${c},${r}`;
  let t = tiles.get(key);
  if (!t) tiles.set(key, (t = new Texture({ source: sheet.source, frame: new Rectangle(c * 17, r * 17, 16, 16) })));
  return t;
}
function put(parent: Container, sheet: Texture, c: number, r: number, x: number, y: number) {
  const s = new Sprite(tile(sheet, c, r));
  s.position.set(x, y);
  parent.addChild(s);
}

export const COLORS = {
  outside: 0x151822,
  wall: 0x33435a,
  baseboard: 0x232d3e,
  floor: 0x7a5c43,
  plank: 0x6c503a,
  night: 0x0e1119,
  bezel: 0x232a38,
  amber: 0xf2a93b,
  green: 0x3ddc84,
  mat: 0x3f5f66,
  matEdge: 0x56808a,
  glass: 0xb8d8e6,
  frame: 0xd9e4ea,
  rug: 0x5b3a4e,
  rugEdge: 0x7d5068,
  pod: 0x3b4a6b,
  podEdge: 0x5a6d96,
  brick: 0x8a4b38,
  mortar: 0x6a3628,
};

// Character layers in the char sheet: skin, shirt, hair as [col, row]. Skin tones sampled for the raised arm.
const SKINS: [number, number, number][] = [[0, 0, 0xe5c49d], [0, 1, 0xc8a480], [0, 2, 0x9f7c4d]];
// The first six are plain shirts; the seventh, a dark suit with a white front, is the team lead's; the last five are the founder roles'.
const SHIRTS: [number, number][] = [[7, 0], [11, 0], [15, 0], [7, 5], [15, 5], [11, 5], [16, 6], [12, 3], [8, 6], [16, 1], [8, 1], [13, 3]];
const HAIRS: [number, number][] = [[19, 0], [23, 0], [19, 4], [23, 4], [19, 8], [21, 0]];

const CHAR = { x: 15, y: 11 };
const DESK = { x: 2, y: 24 };
// Your chair at the PM's table, beside it and facing it; the "?" bubble hangs over it.
const GUEST = { x: 34, y: 28 };
/** The PM's table and your chair, in the desk's own frame: what a tap on it hits. The PM's name goes under it, at `h`. */
export const TABLE = { w: GUEST.x + 16, h: 45 };

export type DeskArt = { root: Container; person: Container; fx: Graphics; skin: number };

/** The three character layers (skin, shirt, hair) for a look seed, drawn at (x, y); returns the skin color. */
function dress(parent: Container, seed: number, x: number, y: number): number {
  const look = decodeLook(seed);
  const skin = SKINS[look.skin];
  for (const [c, r] of [skin, SHIRTS[look.shirt], HAIRS[look.hair]]) put(parent, chars, c, r, x, y);
  return skin[2];
}

/** A desk, or with `table` the PM's oval meeting table with your chair beside it. */
export function buildDesk(seed: number | null, table = false): DeskArt {
  const root = new Container();
  const person = new Container();
  let skin = SKINS[0][2];
  if (seed === null) put(root, indoor, 0, 2, CHAR.x, CHAR.y + 1);
  else skin = dress(person, seed, CHAR.x, CHAR.y);
  root.addChild(person);
  // A desk is two table tiles deep; the oval meeting table is one.
  const tops = table ? [[3, 0, 0, 0], [4, 0, 16, 0]] : [[0, 0, 0, 0], [2, 0, 16, 0], [0, 1, 0, 16], [2, 1, 16, 16]];
  for (const [c, r, dx, dy] of tops) put(root, indoor, c, r, DESK.x + dx, DESK.y + dy);
  if (table) put(root, indoor, 3, 2, GUEST.x, GUEST.y);
  const fx = new Graphics();
  root.addChild(fx);
  return { root, person, fx, skin };
}

/** A sub-agent: the same sprite layers as an employee, a head shorter. */
export function buildIntern(seed: number): Container {
  const intern = new Container();
  dress(intern, seed, 0, 0);
  intern.scale.set(INTERN_SCALE);
  return intern;
}
const INTERN_SCALE = 0.75;

const box = (g: Graphics, x: number, y: number, w: number, h: number, color: number, alpha = 1) =>
  void g.rect(x, y, w, h).fill({ color, alpha });

export const TICK_MS = 120;

export function bob(pose: Pose, f: number): number {
  switch (pose) {
    case "typing": return f % 2;
    case "running": return f % 3 === 0 ? 1 : 0;
    case "reading": return 1;
    case "coffee": return (f >> 3) % 2;
    default: return 0;
  }
}

const SCREEN = { x: 4, y: 18, w: 11, h: 7 };
const KEYS = { x: 15, y: 31 };
const CODE_COLORS = [0x7fd6a2, 0xe8b45c, 0x8ab4f8, 0xd98cb3];
const INK = 0x2a1a05;

function screen(g: Graphics, pose: Pose, f: number) {
  const { x, y, w, h } = SCREEN;
  box(g, x - 1, y - 1, w + 2, h + 2, COLORS.bezel);
  box(g, x + 4, y + h + 1, 3, 1, COLORS.bezel);
  box(g, x + 2, y + h + 2, 7, 1, COLORS.bezel);
  const bg = { typing: 0x0f1824, reading: 0xefe9d6, running: 0x06110a, hand: 0x1b1408, coffee: 0x0b0e14, off: 0x0b0e14 }[pose];
  box(g, x, y, w, h, bg);
  if (pose === "typing") {
    for (let i = 0; i < 3; i++) {
      box(g, x + 1, y + 1 + i * 2, 2 + ((i * 5 + f) % 7), 1, CODE_COLORS[(i + (f >> 2)) % CODE_COLORS.length]);
    }
    if (f % 4 < 2) box(g, x + 3 + ((2 * 5 + f) % 7), y + 5, 1, 1, 0xffffff);
  } else if (pose === "reading") {
    for (let i = 0; i < 3; i++) box(g, x + 1, y + 1 + i * 2, 8 + (i % 2), 1, 0x7a7262);
    box(g, x, y + 1 + (f % 3) * 2, w, 1, COLORS.amber, 0.45);
  } else if (pose === "running") {
    for (let i = 0; i < 4; i++) box(g, x + 1, y + ((i * 2 - (f % 2)) + 7) % 7, 2 + ((i * 3 + f) % 7), 1, COLORS.green);
    if (f % 4 < 2) box(g, x + 8, y + 5, 2, 1, 0xffffff);
  } else if (pose === "hand" && f % 6 < 4) {
    box(g, x + 5, y + 1, 2, 4, COLORS.amber);
    box(g, x + 5, y + 6, 2, 1, COLORS.amber);
  }
}

function bubble(g: Graphics, x: number, y: number, color: number) {
  box(g, x, y, 11, 8, color);
  box(g, x + 5, y + 8, 2, 2, color);
}

/** The "?" over your chair at the PM's table: the PM's turn is over and it waits for your answer. */
function yourTurn(g: Graphics, x: number, y: number) {
  bubble(g, x, y, 0xf3ecd8);
  box(g, x + 4, y + 1, 3, 1, INK);
  box(g, x + 3, y + 2, 1, 1, INK);
  box(g, x + 7, y + 2, 1, 2, INK);
  box(g, x + 5, y + 4, 2, 1, INK);
  box(g, x + 5, y + 6, 2, 1, INK);
}

/** The amber "!" bubble of someone waiting for permission, with its top-left at (x, y). */
function raisedHand(g: Graphics, x: number, y: number) {
  bubble(g, x, y, COLORS.amber);
  box(g, x + 5, y + 2, 2, 3, INK);
  box(g, x + 5, y + 6, 2, 1, INK);
}

/** `table` draws the PM at its table, where a coffee break means your turn. */
export function drawDesk(g: Graphics, pose: Pose, f: number, skin: number, selected: boolean, hot = false, table = false) {
  g.clear();
  screen(g, pose, f);
  if (hot) {
    // A folded name card, the mark of a shared desk.
    box(g, 4, 35, 9, 6, 0xf3ecd8);
    box(g, 4, 35, 9, 1, COLORS.amber);
    box(g, 5, 37, 6, 1, 0x7a7262);
    box(g, 5, 39, 4, 1, 0x7a7262);
  }
  if (pose === "reading") {
    box(g, KEYS.x, 30, 12, 5, 0x8a5a3c);
    box(g, KEYS.x + 1, 30, 5, 4, 0xf3ecd8);
    box(g, KEYS.x + 7, f % 4 === 3 ? 29 : 30, 5, f % 4 === 3 ? 5 : 4, 0xf3ecd8);
    for (let i = 0; i < 2; i++) {
      box(g, KEYS.x + 2, 31 + i * 2, 3, 1, 0xb9b09a);
      box(g, KEYS.x + 8, 31 + i * 2, 3, 1, 0xb9b09a);
    }
  } else {
    box(g, KEYS.x, KEYS.y, 10, 3, 0xc9ccd6);
    for (let i = 0; i < 4; i++) box(g, KEYS.x + 1 + i * 2, KEYS.y + 1, 1, 1, 0x8d92a3);
    if (pose === "typing") {
      box(g, KEYS.x + 1 + (f % 4) * 2, KEYS.y + 1, 1, 1, 0xffffff);
      box(g, KEYS.x + 8 - (f % 3) * 2, KEYS.y + 1, 1, 1, 0xffffff);
      box(g, KEYS.x + 1 + (f % 2) * 5, 29 + (f % 2), 2, 2, skin);
      box(g, KEYS.x + 7 - (f % 2) * 4, 30 - (f % 2), 2, 2, skin);
    }
  }
  const head = CHAR.x + 8;
  if (pose === "hand") {
    const wave = f % 4 < 2 ? 0 : 1;
    box(g, CHAR.x + 15, 14, 2, 10, skin);
    box(g, CHAR.x + 14 + wave, 11, 4, 3, skin);
    raisedHand(g, 3, 1 + wave);
  } else if (pose === "running") {
    bubble(g, head - 6, 1, 0x10261a);
    for (let i = 0; i < 3; i++) box(g, head - 4 + i * 3, f % 3 === i ? 3 : 5, 2, 2, COLORS.green);
  } else if (pose === "coffee" && table) {
    yourTurn(g, GUEST.x + 3, GUEST.y - 15 + ((f >> 3) % 2));
  } else if (pose === "coffee") {
    box(g, CHAR.x + 14, 18, 5, 5, 0xe9e4d6);
    box(g, CHAR.x + 14, 18, 5, 1, 0x4a2f1c);
    box(g, CHAR.x + 19, 19, 1, 3, 0xe9e4d6);
    for (let i = 0; i < 2; i++) {
      const phase = (f + i * 2) % 4;
      box(g, CHAR.x + 15 + i * 2 + (phase % 2), 16 - phase, 1, 1, 0xdfe6f1, 1 - phase / 4);
    }
  }
  if (selected) {
    const c = COLORS.amber, x = 1, y = 7, w = (table ? TABLE.w : CELL.w) - 2, h = (table ? TABLE.h : 58) - 7;
    box(g, x, y, w, 1, c);
    box(g, x, y + h - 1, w, 1, c);
    box(g, x, y, 1, h, c);
    box(g, x + w - 1, y, 1, h, c);
  }
}

/** The PM's corner: a rug under the table, glass on the two sides that face the office, a gap to walk in by. */
function glassCorner(g: Graphics, c: Box) {
  box(g, c.x + 3, c.y + 3, c.w - 8, c.h - 16, COLORS.rug);
  box(g, c.x + 4, c.y + 4, c.w - 10, c.h - 18, COLORS.rugEdge, 0.5);
  box(g, c.x + 5, c.y + 5, c.w - 12, c.h - 20, COLORS.rug);
  // The doorway is the gap between the front pane and the side wall.
  const rx = c.x + c.w - 3, by = c.y + c.h - 10, x = c.x + 1, w = c.w - 22;
  box(g, rx, c.y, 3, c.h, COLORS.glass, 0.35);
  box(g, rx, c.y, 1, c.h, COLORS.frame, 0.8);
  box(g, x, by, w, 10, COLORS.glass, 0.3);
  box(g, x, by, w, 1, COLORS.frame);
  box(g, x, by + 9, w, 1, COLORS.frame, 0.7);
  for (let m = x + 13; m < x + w - 2; m += 13) box(g, m, by + 1, 1, 8, COLORS.frame, 0.5);
  box(g, x + w - 1, by, 1, 10, COLORS.frame);
}

/** A room's walls, floor and desks. A tap on an empty desk calls `onHire`, on the empty PM table `onStartPm`. */
export function buildRoom(r: RoomLayout, onHire?: () => void, onStartPm?: () => void) {
  const root = new Container();
  const g = new Graphics();
  root.addChild(g);
  box(g, r.x, r.y, r.w, r.h, COLORS.floor);
  for (let y = r.y + ROOM.wall + 8; y < r.y + r.h; y += 8) box(g, r.x, y, r.w, 1, COLORS.plank);
  box(g, r.x, r.y, r.w, ROOM.wall, COLORS.wall);
  // A Founder project's room has a warm brick wall: courses 5 high, the joints offset every other course.
  if (r.founder) {
    box(g, r.x, r.y, r.w, ROOM.wall - 3, COLORS.brick);
    for (let course = 0, y = r.y + 4; y < r.y + ROOM.wall - 3; course++, y += 5) {
      box(g, r.x, y, r.w, 1, COLORS.mortar);
      for (let x = r.x + (course % 2 ? 5 : 0); x < r.x + r.w; x += 10) box(g, x, y - 4, 1, 4, COLORS.mortar);
    }
  }
  box(g, r.x, r.y + ROOM.wall - 3, r.w, 3, COLORS.baseboard);
  for (const [x, y, w, h] of [[r.x, r.y, r.w, 1], [r.x, r.y + r.h - 1, r.w, 1], [r.x, r.y, 1, r.h], [r.x + r.w - 1, r.y, 1, r.h]]) {
    box(g, x, y, w, h, COLORS.outside);
  }
  // A team's rug runs under its sign and every desk of its pod.
  for (const p of r.pods) {
    box(g, p.x - 2, p.y, p.w + 4, p.h - 4, COLORS.pod);
    box(g, p.x - 1, p.y + 1, p.w + 2, p.h - 6, COLORS.podEdge, 0.5);
    box(g, p.x, p.y + 2, p.w, p.h - 8, COLORS.pod);
  }
  for (const d of r.desks) {
    if (!d.hot) continue;
    box(g, d.x, d.y + 8, CELL.w, CELL.h - 10, COLORS.mat);
    box(g, d.x + 1, d.y + 9, CELL.w - 2, CELL.h - 12, COLORS.matEdge, 0.5);
  }
  put(root, indoor, 16, 0, r.x + r.w - 20, r.y + ROOM.wall - 14);
  glassCorner(g, r.corner);
  for (const d of r.desks) {
    if (d.employee) continue;
    const empty = buildDesk(null, d.table);
    empty.root.position.set(d.x, d.y);
    drawDesk(empty.fx, "off", 0, empty.skin, false, false, d.table);
    const onTap = d.table ? onStartPm : onHire;
    if (onTap) {
      empty.root.eventMode = "static";
      empty.root.hitArea = d.table ? new Rectangle(0, 0, TABLE.w, TABLE.h) : new Rectangle(0, 0, CELL.w, CELL.h);
      empty.root.cursor = "pointer";
      empty.root.on("pointertap", onTap);
    }
    root.addChild(empty.root);
  }
  return root;
}

const DOOR_WOOD = 0x8a5a3c, DOOR_PANEL = 0x6f4630;

/** The hallway behind the lobby: a wall and floor per row of doors, a door and mat for each project, a plant at the row ends. */
export function buildHallway(doors: DoorSlot[], width: number, height: number) {
  const root = new Container();
  const g = new Graphics();
  root.addChild(g);
  const ys = [...new Set(doors.map((d) => d.y))];
  if (!ys.length) ys.push(8);
  ys.forEach((y, i) => {
    const wallTop = i === 0 ? 0 : y, floorTop = y + DOOR.wall, floorEnd = ys[i + 1] ?? height;
    box(g, 0, floorTop, width, floorEnd - floorTop, COLORS.floor);
    for (let py = floorTop + 8; py < floorEnd; py += 8) box(g, 0, py, width, 1, COLORS.plank);
    box(g, 0, wallTop, width, floorTop - wallTop, COLORS.wall);
    box(g, 0, wallTop, width, 2, COLORS.baseboard);
    box(g, 0, floorTop - 3, width, 3, COLORS.baseboard);
    const row = doors.filter((d) => d.y === y);
    if (row.length) {
      for (const x of [row[0].x - 18, row[row.length - 1].x + DOOR.w + 2]) if (x >= 0 && x + 16 <= width) put(root, indoor, 16, 0, x, floorTop - 14);
    }
  });
  for (const d of doors) {
    const { x, y } = d, lit = d.count > 0;
    box(g, x + 8, y + 66, 40, 6, COLORS.mat);
    box(g, x + 9, y + 67, 38, 1, COLORS.matEdge, 0.7);
    box(g, x + 16, y + 3, 24, 4, lit ? COLORS.amber : COLORS.bezel);
    box(g, x + 10, y + 10, 36, 52, COLORS.baseboard);
    box(g, x + 12, y + 12, 32, 50, DOOR_WOOD);
    for (const [px, py, pw, ph] of [[15, 15, 12, 20], [29, 15, 12, 20], [15, 39, 12, 20], [29, 39, 12, 20]]) box(g, x + px, y + py, pw, ph, DOOR_PANEL);
    box(g, x + 38, y + 38, 3, 3, COLORS.amber);
    if (!lit) box(g, x + 4, y + 2, 48, 62, COLORS.night, 0.62);
  }
  return root;
}

/** Redraws the raised-hand bubble over one door; `wave` is 0 or 1. */
export function drawDoorHand(g: Graphics, wave: number) {
  g.clear();
  raisedHand(g, DOOR.w - 15, 2 + wave);
}
