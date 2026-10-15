// The PixiJS scene: draws the office from the latest server state, animates each employee from its pose.
import { Application, Container, Graphics, Rectangle, Text } from "pixi.js";
import type { OfficeState } from "../server/office.ts";
import { bob, buildDesk, buildRoom, COLORS, drawDesk, loadArt, TICK_MS, type DeskArt } from "./art.ts";
import { CELL, layoutOffice, ROOM } from "./layout.ts";
import { identityOf } from "./people.ts";
import { poseOf } from "./pose.ts";

export type Scene = { update(state: OfficeState, selected: string | null): void; destroy(): void };

type Person = { art: DeskArt; name: Text; employee: OfficeState["employees"][string]; drawn: string };
type Dimmer = { overlay: Graphics; label: Text; target: number; now: number };

const LABEL = { fontFamily: "ui-monospace, Menlo, monospace", fontSize: 12, fontWeight: "700", fill: 0xe9e4d6 } as const;
const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + "…" : s);

export async function createScene(host: HTMLElement, onSelect: (id: string | null) => void): Promise<Scene> {
  await loadArt();
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

  const world = new Container();
  const rooms = new Container();
  const desks = new Container();
  const roomLabels = new Container();
  const names = new Container();
  names.eventMode = roomLabels.eventMode = "none";
  world.addChild(rooms, desks);
  app.stage.addChild(world, roomLabels, names);
  app.stage.eventMode = "static";
  app.stage.on("pointertap", (e) => e.target === app.stage && onSelect(null));

  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
  const people = new Map<string, Person>();
  const dimmers = new Map<string, Dimmer>();
  let latest: OfficeState = { rooms: {}, employees: {} };
  let selected: string | null = null;

  function render() {
    // Integer art scale keeps pixels square; narrow windows drop to 2x.
    const scale = host.clientWidth < 760 ? 2 : 3;
    world.scale.set(scale);
    const { rooms: laidOut, height } = layoutOffice(latest, Math.floor(host.clientWidth / scale));
    app.renderer.resize(host.clientWidth, Math.max(host.clientHeight, height * scale));
    app.stage.hitArea = app.screen;

    rooms.removeChildren().forEach((c) => c.destroy({ children: true }));
    roomLabels.removeChildren().forEach((c) => c.destroy());
    const present = new Set<string>();
    for (const r of laidOut) {
      const shell = buildRoom(r);
      const overlay = new Graphics().rect(r.x, r.y, r.w, r.h).fill(COLORS.night);
      overlay.alpha = dimmers.get(r.room.id)?.now ?? 0;
      rooms.addChild(shell, overlay);

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
        if (!p) {
          const art = buildDesk(identityOf(e.sessionId).seed);
          art.root.eventMode = "static";
          art.root.hitArea = new Rectangle(0, 0, CELL.w, CELL.h);
          art.root.cursor = "pointer";
          art.root.on("pointertap", () => onSelect(e.sessionId));
          desks.addChild(art.root);
          p = { art, name: new Text({ text: identityOf(e.sessionId).name, style: LABEL }), employee: e, drawn: "" };
          people.set(e.sessionId, p);
        }
        p.employee = e;
        p.drawn = "";
        p.art.root.position.set(d.x, d.y);
        p.name.anchor.set(0.5, 0);
        p.name.position.set((d.x + CELL.w / 2) * scale, (d.y + 57) * scale);
        names.addChild(p.name);
      }
    }
    for (const [id, p] of people) {
      if (seen.has(id)) continue;
      p.art.root.destroy({ children: true });
      p.name.destroy();
      people.delete(id);
    }
  }

  app.ticker.add(() => {
    const f = reduceMotion.matches ? 0 : Math.floor(performance.now() / TICK_MS);
    for (const [id, p] of people) {
      const pose = poseOf(p.employee);
      const key = `${pose}|${f}|${id === selected}`;
      if (key === p.drawn) continue;
      p.drawn = key;
      p.art.person.y = bob(pose, f);
      p.art.person.alpha = p.name.alpha = pose === "off" ? 0.4 : 1;
      drawDesk(p.art.fx, pose, f, p.art.skin, id === selected);
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
