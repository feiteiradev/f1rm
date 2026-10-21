// The PixiJS scene: draws the office from the latest server state, animates each employee from its pose.
import { Container, Graphics, Rectangle, Text } from "pixi.js";
import type { OfficeState } from "../server/office.ts";
import { seedFor, seedOf } from "../people.ts";
import { bob, buildDesk, buildIntern, buildRoom, COLORS, drawDesk, LEAD_TAG, loadArt, newApp, TABLE, TICK_MS, type DeskArt } from "./art.ts";
import { CELL, layoutOffice, ROOM, scaleFor } from "./layout.ts";
import { showsLeadTag } from "./lead.ts";
import { poseOf } from "./pose.ts";
import { buildTeamSign, buildWhiteboard, teamSignLabel, whiteboardCount } from "./whiteboard.ts";

export type Scene = { update(state: OfficeState, selected: string | null): void; destroy(): void };

type Person = { art: DeskArt; name: Text; tag?: Text; employee: OfficeState["employees"][string]; seed: number; hot: boolean; table: boolean; drawn: string };
/** An intern walking out from its parent's seat (`born`), or back to it once stopped (`left`); times are performance.now() ms. */
type Walker = { sprite: Container; parent: string; slot: number; born: number; left?: number };
type Dimmer = { overlay: Graphics; label: Text; target: number; now: number };

const LABEL = { fontFamily: "ui-monospace, Menlo, monospace", fontSize: 12, fontWeight: "700", fill: 0xe9e4d6 } as const;
const TAG = { ...LABEL, fontSize: 11, fill: 0xf2c94c, stroke: { color: 0x141b2b, width: 3 } } as const;
// Art pixels in a desk's own frame: where an intern starts (its parent's seat) and the spots it stands in, in front of the desk.
const SEAT = { x: 17, y: 14 };
// ponytail: three standing spots; a fourth intern of one parent stands on the first. Add spots if sub-agent fan-out that wide shows up.
const STANDS = [{ x: 22, y: 41 }, { x: 4, y: 41 }, { x: 13, y: 45 }];
const WALK_MS = 700;
const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + "…" : s);

export async function createScene(host: HTMLElement, onSelect: (id: string | null) => void, onBoard: (roomId: string, team?: string) => void, onHire?: () => void, onStartPm?: () => void): Promise<Scene> {
  await loadArt();
  const app = await newApp(host);

  const world = new Container();
  const rooms = new Container();
  const desks = new Container();
  const walkersLayer = new Container();
  const roomLabels = new Container();
  const names = new Container();
  names.eventMode = roomLabels.eventMode = "none";
  world.addChild(rooms, desks, walkersLayer);
  app.stage.addChild(world, roomLabels, names);
  app.stage.eventMode = "static";
  app.stage.on("pointertap", (e) => e.target === app.stage && onSelect(null));

  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
  const people = new Map<string, Person>();
  const walkers = new Map<string, Walker>();
  const dimmers = new Map<string, Dimmer>();
  let latest: OfficeState = { rooms: {}, employees: {}, interns: {} };
  let selected: string | null = null;

  function render() {
    const scale = scaleFor(host.clientWidth);
    world.scale.set(scale);
    const { rooms: laidOut, height } = layoutOffice(latest, Math.floor(host.clientWidth / scale), Math.floor(host.clientHeight / scale));
    app.renderer.resize(host.clientWidth, Math.max(host.clientHeight, height * scale));
    app.stage.hitArea = app.screen;

    rooms.removeChildren().forEach((c) => c.destroy({ children: true }));
    roomLabels.removeChildren().forEach((c) => c.destroy());
    const present = new Set<string>();
    for (const r of laidOut) {
      const shell = buildRoom(r, onHire, onStartPm);
      const overlay = new Graphics().rect(r.x, r.y, r.w, r.h).fill(COLORS.night);
      overlay.alpha = dimmers.get(r.room.id)?.now ?? 0;
      // Lets taps through to the whiteboard under it.
      overlay.eventMode = "none";
      const rows = latest.boards?.[r.room.id] ?? [];
      const signs = r.pods.map((p) => buildTeamSign(p, latest.teamBoards?.[r.room.id]?.[p.team] ?? [], () => onBoard(r.room.id, p.team)));
      rooms.addChild(shell, buildWhiteboard(r, rows, () => onBoard(r.room.id)), ...signs, overlay);
      for (const p of r.pods) roomLabels.addChild(teamSignLabel(p, scale));
      const count = whiteboardCount(r, rows, scale);
      if (count) {
        count.alpha = r.empty ? 0.4 : 1;
        roomLabels.addChild(count);
      }

      const [table] = r.desks;
      // The founder's list: approved work on the PM's board waiting to go out, counted under the table.
      const toPublish = rows.filter((row) => row.status === "publish").length;
      if (toPublish) {
        const note = new Text({ text: `${toPublish} to publish`, style: { ...LABEL, fontSize: 11, fill: 0xe08ad3 } });
        note.anchor.set(0.5, 0);
        note.position.set((table.x + CELL.w / 2) * scale, (table.y + TABLE.h) * scale + 14);
        roomLabels.addChild(note);
      }
      if (!table.employee && onStartPm) {
        const invite = new Text({ text: "Start PM", style: LABEL });
        invite.anchor.set(0.5, 0);
        invite.alpha = 0.7;
        invite.position.set((table.x + CELL.w / 2) * scale, (table.y + TABLE.h) * scale);
        roomLabels.addChild(invite);
      }

      const label = new Text({ text: clip(r.empty ? `${r.room.name} (empty)` : r.room.name, 22), style: LABEL });
      label.position.set((r.x + ROOM.pad) * scale, (r.y + 5) * scale);
      roomLabels.addChild(label);
      present.add(r.room.id);
      const prev = dimmers.get(r.room.id);
      dimmers.set(r.room.id, { overlay, label, target: r.empty ? 0.62 : 0, now: prev?.now ?? (r.empty ? 0.62 : 0) });
    }
    for (const id of [...dimmers.keys()]) if (!present.has(id)) dimmers.delete(id);

    const seen = new Set<string>();
    for (const r of laidOut) {
      for (const d of r.desks) {
        const e = d.employee;
        if (!e) continue;
        seen.add(e.sessionId);
        let p = people.get(e.sessionId);
        // A freelancer whose role turns up later changes look, and a second PM who moves up to the table changes furniture.
        if (p && (p.seed !== seedFor(e) || p.table !== !!d.table)) {
          removePerson(e.sessionId, p);
          p = undefined;
        }
        if (!p) {
          const art = buildDesk(seedFor(e), d.table);
          art.root.eventMode = "static";
          art.root.hitArea = d.table ? new Rectangle(0, 0, TABLE.w, TABLE.h) : new Rectangle(0, 0, CELL.w, CELL.h);
          art.root.cursor = "pointer";
          art.root.on("pointertap", () => onSelect(e.sessionId));
          desks.addChild(art.root);
          p = { art, name: new Text({ text: e.name, style: LABEL }), employee: e, seed: seedFor(e), hot: d.hot, table: !!d.table, drawn: "" };
          people.set(e.sessionId, p);
        }
        p.employee = e;
        p.hot = d.hot;
        p.name.text = e.name;
        p.drawn = "";
        p.art.root.position.set(d.x, d.y);
        p.name.anchor.set(0.5, 0);
        p.name.position.set((d.x + CELL.w / 2) * scale, (d.y + (d.table ? TABLE.h : 57)) * scale);
        names.addChild(p.name);
        if (showsLeadTag(e)) {
          p.tag ??= new Text({ text: "LEAD", style: TAG });
          p.tag.anchor.set(0.5, 1);
          p.tag.position.set((d.x + LEAD_TAG.x) * scale, (d.y + LEAD_TAG.y) * scale);
          names.addChild(p.tag);
        }
      }
    }
    for (const [id, p] of people) if (!seen.has(id)) removePerson(id, p);

    const now = performance.now();
    for (const [id, i] of Object.entries(latest.interns)) {
      const w = walkers.get(id);
      if (w) delete w.left;
      else if (people.has(i.parent)) {
        const taken = new Set([...walkers.values()].filter((o) => o.parent === i.parent).map((o) => o.slot));
        const sprite = buildIntern(seedOf(id));
        walkersLayer.addChild(sprite);
        walkers.set(id, {
          sprite,
          parent: i.parent,
          slot: Math.max(0, STANDS.findIndex((_, k) => !taken.has(k))),
          born: reduceMotion.matches ? now - WALK_MS : now,
        });
      }
    }
    for (const [id, w] of walkers) {
      if (id in latest.interns && people.has(w.parent)) continue;
      // Walk back to the desk, unless the desk is gone or motion is off.
      if (people.has(w.parent) && !reduceMotion.matches) w.left ??= now;
      else removeWalker(id, w);
    }
  }

  function removePerson(id: string, p: Person) {
    p.art.root.destroy({ children: true });
    p.name.destroy();
    p.tag?.destroy();
    people.delete(id);
  }
  function removeWalker(id: string, w: Walker) {
    w.sprite.destroy({ children: true });
    walkers.delete(id);
  }

  app.ticker.add(() => {
    const now = performance.now();
    const f = reduceMotion.matches ? 0 : Math.floor(now / TICK_MS);
    for (const [id, w] of walkers) {
      const desk = people.get(w.parent)!.art.root;
      const t = w.left === undefined ? Math.min(1, (now - w.born) / WALK_MS) : 1 - (now - w.left) / WALK_MS;
      if (t <= 0) {
        removeWalker(id, w);
        continue;
      }
      const stand = STANDS[w.slot];
      w.sprite.position.set(desk.x + SEAT.x + (stand.x - SEAT.x) * t, desk.y + SEAT.y + (stand.y - SEAT.y) * t + (t < 1 ? f % 2 : 0));
      w.sprite.alpha = Math.min(1, t * 4);
    }
    for (const [id, p] of people) {
      const pose = poseOf(p.employee);
      const key = `${pose}|${f}|${id === selected}`;
      if (key === p.drawn) continue;
      p.drawn = key;
      p.art.person.y = bob(pose, f);
      p.art.person.alpha = p.name.alpha = pose === "off" ? 0.4 : 1;
      if (p.tag) p.tag.alpha = p.name.alpha;
      drawDesk(p.art.fx, pose, f, p.art.skin, id === selected, p.hot, p.table);
    }
    for (const d of dimmers.values()) {
      d.now += (d.target - d.now) * 0.12;
      if (Math.abs(d.target - d.now) < 0.01) d.now = d.target;
      d.overlay.alpha = d.now;
      d.label.alpha = 1 - d.now * 0.6;
    }
  });

  const resize = new ResizeObserver(render);
  resize.observe(host);

  return {
    update(state, sel) {
      latest = state;
      selected = sel;
      render();
    },
    destroy() {
      resize.disconnect();
      app.destroy(true, { children: true });
    },
  };
}
