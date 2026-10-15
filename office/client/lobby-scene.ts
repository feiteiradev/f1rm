// The PixiJS lobby: the hallway art behind the doors. The doors themselves are buttons laid over it by the page.
import { Container, Graphics } from "pixi.js";
import type { OfficeState } from "../server/office.ts";
import { buildHallway, drawDoorHand, loadArt, newApp, TICK_MS } from "./art.ts";
import { scaleFor } from "./layout.ts";
import { layoutLobby } from "./lobby.ts";

export type Lobby = { update(state: OfficeState): void; destroy(): void };

export async function createLobby(host: HTMLElement): Promise<Lobby> {
  await loadArt();
  const app = await newApp(host);
  const world = new Container();
  app.stage.addChild(world);
  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
  let hands: Graphics[] = [];
  let latest: OfficeState = { rooms: {}, employees: {}, interns: {} };

  function render() {
    const scale = scaleFor(host.clientWidth);
    world.scale.set(scale);
    const width = Math.floor(host.clientWidth / scale);
    const { doors, height } = layoutLobby(latest, width, Math.floor(host.clientHeight / scale));
    const px = Math.max(host.clientHeight, height * scale);
    app.renderer.resize(host.clientWidth, px);
    world.removeChildren().forEach((c) => c.destroy({ children: true }));
    world.addChild(buildHallway(doors, width, Math.ceil(px / scale)));
    hands = doors.filter((d) => d.waiting).map((d) => {
      const hand = new Graphics();
      hand.position.set(d.x, d.y);
      world.addChild(hand);
      return hand;
    });
  }

  app.ticker.add(() => {
    const wave = reduceMotion.matches ? 0 : Math.floor(performance.now() / TICK_MS) % 4 < 2 ? 0 : 1;
    for (const h of hands) drawDoorHand(h, wave);
  });

  const resize = new ResizeObserver(render);
  resize.observe(host);

  return {
    update(state) {
      latest = state;
      render();
    },
    destroy() {
      resize.disconnect();
      app.destroy(true, { children: true });
    },
  };
}
