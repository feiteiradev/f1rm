// Drawing: CC0 Kenney tiles for furniture and people, a few pixels of code-drawn props on top.
import { Assets, Container, Graphics, Rectangle, Sprite, Texture } from "pixi.js";
import indoorUrl from "./assets/roguelikeIndoor_transparent.png";
import charUrl from "./assets/roguelikeChar_transparent.png";
import { CELL, ROOM, type RoomLayout } from "./layout.ts";
import type { Pose } from "./pose.ts";

let indoor: Texture, chars: Texture;
export async function loadArt() {
  [indoor, chars] = await Promise.all([Assets.load<Texture>(indoorUrl), Assets.load<Texture>(charUrl)]);
  for (const t of [indoor, chars]) t.source.scaleMode = "nearest";
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
};

// Character layers in the char sheet: skin, shirt, hair as [col, row]. Skin tones sampled for the raised arm.
const SKINS: [number, number, number][] = [[0, 0, 0xe5c49d], [0, 1, 0xc8a480], [0, 2, 0x9f7c4d]];
const SHIRTS: [number, number][] = [[7, 0], [11, 0], [15, 0], [7, 5], [15, 5], [11, 5]];
const HAIRS: [number, number][] = [[19, 0], [23, 0], [19, 4], [23, 4], [19, 8], [21, 0]];

const CHAR = { x: 15, y: 11 };
const DESK = { x: 2, y: 24 };

export type DeskArt = { root: Container; person: Container; fx: Graphics; skin: number };

export function buildDesk(seed: number | null): DeskArt {
  const root = new Container();
  const person = new Container();
  const skinPick = SKINS[(seed ?? 0) % SKINS.length];
  if (seed === null) {
    put(root, indoor, 0, 2, CHAR.x, CHAR.y + 1);
  } else {
    const [sc, sr] = skinPick, [hc, hr] = SHIRTS[(seed >>> 3) % SHIRTS.length], [pc, pr] = HAIRS[(seed >>> 7) % HAIRS.length];
    put(person, chars, sc, sr, CHAR.x, CHAR.y);
    put(person, chars, hc, hr, CHAR.x, CHAR.y);
    put(person, chars, pc, pr, CHAR.x, CHAR.y);
  }
  root.addChild(person);
  for (const [c, r, dx, dy] of [[0, 0, 0, 0], [2, 0, 16, 0], [0, 1, 0, 16], [2, 1, 16, 16]]) {
    put(root, indoor, c, r, DESK.x + dx, DESK.y + dy);
  }
  const fx = new Graphics();
  root.addChild(fx);
  return { root, person, fx, skin: skinPick[2] };
}

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

export function drawDesk(g: Graphics, pose: Pose, f: number, skin: number, selected: boolean) {
  g.clear();
  screen(g, pose, f);
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
    bubble(g, 3, 1 + wave, COLORS.amber);
    box(g, 8, 3 + wave, 2, 3, INK);
    box(g, 8, 7 + wave, 2, 1, INK);
  } else if (pose === "running") {
    bubble(g, head - 6, 1, 0x10261a);
    for (let i = 0; i < 3; i++) box(g, head - 4 + i * 3, f % 3 === i ? 3 : 5, 2, 2, COLORS.green);
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
    const c = COLORS.amber, x = 1, y = 7, w = CELL.w - 2, h = 51;
    box(g, x, y, w, 1, c);
    box(g, x, y + h - 1, w, 1, c);
    box(g, x, y, 1, h, c);
    box(g, x + w - 1, y, 1, h, c);
  }
}

export function buildRoom(r: RoomLayout) {
  const root = new Container();
  const g = new Graphics();
  root.addChild(g);
  box(g, r.x, r.y, r.w, r.h, COLORS.floor);
  for (let y = r.y + ROOM.wall + 8; y < r.y + r.h; y += 8) box(g, r.x, y, r.w, 1, COLORS.plank);
  box(g, r.x, r.y, r.w, ROOM.wall, COLORS.wall);
  box(g, r.x, r.y + ROOM.wall - 3, r.w, 3, COLORS.baseboard);
  for (const [x, y, w, h] of [[r.x, r.y, r.w, 1], [r.x, r.y + r.h - 1, r.w, 1], [r.x, r.y, 1, r.h], [r.x + r.w - 1, r.y, 1, r.h]]) {
    box(g, x, y, w, h, COLORS.outside);
  }
  put(root, indoor, 19, 12, r.x + r.w - 44, r.y + 2);
  put(root, indoor, 16, 0, r.x + r.w - 20, r.y + ROOM.wall - 14);
  for (const d of r.desks) {
    if (d.employee) continue;
    const empty = buildDesk(null);
    empty.root.position.set(d.x, d.y);
    drawDesk(empty.fx, "off", 0, empty.skin, false);
    root.addChild(empty.root);
  }
  return root;
}
