/**
 * pixi, faked for the viewer stage's tests (pixi needs WebGL, which jsdom
 * has not got). Every display object a renderer or the host adds carries a
 * label, so the stacking order is the world's children's labels, in order.
 * Textures and sprites are recorded so a test can tell which bitmaps were
 * ever drawn and what became of their textures; Graphics record what they
 * draw.
 *
 * A test file mocks pixi with it, and reads the same instance:
 *
 *   import { fake } from "./pixi-fake";
 *   vi.mock("pixi.js/unsafe-eval", () => ({}));
 *   vi.mock("pixi.js", async () => (await import("./pixi-fake")).pixiModule);
 */
export const fake = (() => {
  class Point {
    constructor(
      public x = 0,
      public y = 0,
    ) {}
    set(x: number, y: number = x) {
      this.x = x;
      this.y = y;
    }
  }

  class Node {
    label = "";
    parent: Box | null = null;
    destroyed = false;
    alpha = 1;
    visible = true;
    eventMode = "passive";
    cursor = "";
    x = 0;
    y = 0;
    position = new Point();
    scale = new Point(1, 1);
    /** What clips it (pixi's `mask`): null for nothing. */
    mask: Node | null = null;
    on() {
      return this;
    }
    removeFromParent() {
      this.parent?.removeChild(this);
    }
    destroy(_options?: unknown) {
      this.destroyed = true;
      this.removeFromParent();
    }
  }

  class Box extends Node {
    children: Node[] = [];
    addChild<T extends Node>(child: T): T {
      // pixi re-appends a child it already holds.
      if (child.parent === this) {
        this.children.splice(this.children.indexOf(child), 1);
        this.children.push(child);
        return child;
      }
      child.parent?.removeChild(child);
      this.children.push(child);
      child.parent = this;
      return child;
    }
    removeChild<T extends Node>(child: T): T {
      const i = this.children.indexOf(child);
      if (i >= 0) this.children.splice(i, 1);
      child.parent = null;
      return child;
    }
    override destroy(options?: unknown) {
      const kids = this.children.slice();
      for (const kid of kids) this.removeChild(kid);
      super.destroy(options);
      const deep =
        options === true ||
        (typeof options === "object" &&
          options !== null &&
          (options as { children?: boolean }).children === true);
      if (deep) for (const kid of kids) kid.destroy(options);
    }
  }

  type Op = [string, ...number[]];
  class Graphics extends Box {
    ops: Op[] = [];
    strokes: Array<Record<string, unknown>> = [];
    fills: unknown[] = [];
    rect(x: number, y: number, w: number, h: number) {
      this.ops.push(["rect", x, y, w, h]);
      return this;
    }
    circle(x: number, y: number, r: number) {
      this.ops.push(["circle", x, y, r]);
      return this;
    }
    moveTo(x: number, y: number) {
      this.ops.push(["moveTo", x, y]);
      return this;
    }
    lineTo(x: number, y: number) {
      this.ops.push(["lineTo", x, y]);
      return this;
    }
    fill(style: unknown = {}) {
      this.fills.push(style);
      return this;
    }
    stroke(style: Record<string, unknown> = {}) {
      this.strokes.push(style);
      return this;
    }
    clear() {
      this.ops = [];
      this.strokes = [];
      this.fills = [];
      return this;
    }
    /** The hatch's line ends, as drawn. */
    points(): Array<{ x: number; y: number }> {
      return this.ops
        .filter(([op]) => op === "moveTo" || op === "lineTo")
        .map(([, x, y]) => ({ x: x!, y: y! }));
    }
  }

  class Text extends Box {
    width = 60;
    height = 12;
  }

  interface BitmapLike {
    width: number;
    height: number;
  }

  class TextureSource {
    destroyed = false;
    constructor(public resource: BitmapLike | null) {}
    destroy() {
      this.destroyed = true;
      this.resource = null;
    }
  }

  class Texture {
    source: TextureSource;
    destroyed = false;
    skipCache: unknown;
    width: number;
    height: number;
    constructor(public bitmap: BitmapLike) {
      this.source = new TextureSource(bitmap);
      this.width = bitmap.width;
      this.height = bitmap.height;
    }
    static from(bitmap: BitmapLike, skipCache?: boolean) {
      const t = new Texture(bitmap);
      t.skipCache = skipCache;
      registry.textures.push(t);
      return t;
    }
    destroy(destroySource?: boolean) {
      this.destroyed = true;
      if (destroySource) this.source.destroy();
    }
  }

  class Sprite extends Box {
    constructor(public texture: Texture) {
      super();
      registry.sprites.push(this);
    }
    override destroy(options?: unknown) {
      super.destroy(options);
      const o = options as { texture?: boolean; textureSource?: boolean };
      if (o?.texture) this.texture.destroy(o.textureSource);
    }
  }

  class Application {
    canvas = document.createElement("canvas");
    stage = new Box();
    screen = { width: 0, height: 0 };
    ticker = { add: () => {}, remove: () => {} };
    renderer = {
      background: { color: 0 },
      resize: (w: number, h: number) => {
        this.screen = { width: w, height: h };
      },
      // A texture source put on the GPU ahead of its first draw.
      texture: {
        initSource: (source: TextureSource) => {
          registry.uploaded.push(source);
        },
      },
      // A WebGL context only when a test names its texture limit.
      gl:
        registry.maxTextureSize === null
          ? undefined
          : {
              MAX_TEXTURE_SIZE: 0x0d33,
              getParameter: (p: number) =>
                p === 0x0d33 ? registry.maxTextureSize : null,
            },
    };
    destroyed = false;
    /** Whether its init has finished (resolved or rejected). */
    settled = false;
    /** Destroyed while its init was still running: the leak to avoid. */
    destroyedMidInit = false;
    /** Ends a held init; with `fail`, it rejects. */
    finishInit: (fail?: boolean) => void = () => {};
    private gate: Promise<void>;
    constructor() {
      registry.created.push(this);
      this.gate = registry.holdInit
        ? new Promise<void>((resolve, reject) => {
            this.finishInit = (fail) =>
              fail ? reject(new Error("no WebGL")) : resolve();
          })
        : Promise.resolve();
    }
    async init(opts: { width: number; height: number }) {
      try {
        await this.gate;
      } finally {
        this.settled = true;
      }
      this.screen = { width: opts.width, height: opts.height };
      this.canvas.getBoundingClientRect = () =>
        ({
          left: 0,
          top: 0,
          right: opts.width,
          bottom: opts.height,
          width: opts.width,
          height: opts.height,
          x: 0,
          y: 0,
          toJSON: () => ({}),
        }) as DOMRect;
      registry.apps.push(this);
    }
    destroy() {
      if (!this.settled) this.destroyedMidInit = true;
      this.destroyed = true;
      this.canvas.remove();
    }
  }

  const registry = {
    /** Every app whose init finished. */
    apps: [] as Application[],
    /** Every app constructed. */
    created: [] as Application[],
    /** Inits wait for `finishInit` while this is on. */
    holdInit: false,
    textures: [] as Texture[],
    sprites: [] as Sprite[],
    /** Every texture source uploaded ahead of its first draw, in order. */
    uploaded: [] as TextureSource[],
    /** The GL context's MAX_TEXTURE_SIZE; null: the renderer has no GL context. */
    maxTextureSize: null as number | null,
  };

  return { Box, Graphics, Sprite, Texture, Text, Application, registry };
})();

/** The module `vi.mock("pixi.js", …)` stands in with. */
export const pixiModule = {
  Application: fake.Application,
  Container: fake.Box,
  Graphics: fake.Graphics,
  Sprite: fake.Sprite,
  Text: fake.Text,
  Texture: fake.Texture,
};
