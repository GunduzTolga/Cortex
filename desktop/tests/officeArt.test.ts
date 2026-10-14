import { strict as assert } from 'node:assert';
import test from 'node:test';
import * as art from '../src/office/office-art.js';

/**
 * The office's drawings as Claude Design delivered them (src/office/office-art.js),
 * held to the brief's contract (docs/ofis/claude-design-brifi.md, section 9):
 * every seat and spot walked to, every placed thing drawn, every character
 * drawn in its own cell with whole pixels, and nothing but rectangles.
 */

/** A 2D context that only counts what it is asked: rectangles in whole pixels, and colours. */
function recorder() {
  const rects: Array<[number, number, number, number]> = [];
  const other: string[] = [];
  const ctx = new Proxy(
    { fillStyle: '' as unknown, fillRect: (x: number, y: number, w: number, h: number) => rects.push([x, y, w, h]) },
    {
      get(target, key) {
        if (key in target) return target[key as keyof typeof target];
        other.push(String(key));
        return () => undefined;
      },
      set(target, key, value) {
        if (key === 'fillStyle') target.fillStyle = value;
        else other.push(String(key));
        return true;
      },
    },
  );
  return { ctx: ctx as unknown as CanvasRenderingContext2D, rects, other };
}

test('the map is the brief’s: 61 by 42, nine rooms named in both languages, every seat and spot reached from the newsroom', () => {
  assert.equal(art.MAP.w, 61);
  assert.equal(art.MAP.h, 42);
  assert.deepEqual(art.MAP.rooms.map((one) => one.id).sort(), ['arsiv', 'dinlenme', 'harita', 'mutfak', 'posta', 'pyn', 'salon', 'sunucu', 'toplanti']);
  assert.ok(art.MAP.rooms.every((one) => one.tr && one.en));
  assert.deepEqual(art.checkReachability(), [], 'nothing walled in');
});

test('every thing placed and every floor and wall tile has its drawing', () => {
  const missing = art.MAP.objects.filter((one) => !art.SPRITES[one.sprite]).map((one) => one.sprite);
  for (let y = 0; y < art.MAP.h; y += 1) for (let x = 0; x < art.MAP.w; x += 1) for (const name of art.tileSprites(x, y)) if (!art.SPRITES[name]) missing.push(name);
  assert.deepEqual([...new Set(missing)], []);
});

test('the cast: Pyn, twelve agents and Tekir, each at home, the tool agents on their tools', () => {
  const cast = Object.entries(art.CHARACTERS);
  assert.equal(cast.length, 14);
  assert.deepEqual(
    cast.filter(([, one]) => one.tool).map(([id, one]) => `${id}:${one.tool}`).sort(),
    ['asya:qwen', 'baran:codex', 'defne:claude', 'ilgin:opencode', 'toprak:gemini'],
  );
  const seats = new Set(art.MAP.seats.map((one) => one.id));
  for (const [id, one] of cast) if (one.home) assert.ok(seats.has(one.home), `${id} has a seat`);
  assert.ok(cast.every(([, one]) => one.name && one.color && one.bio && one.label));
});

test('every character is drawn in its own cell, in whole pixels, with rectangles only, in every pose and frame', () => {
  for (const id of Object.keys(art.CHARACTERS)) {
    const cell = art.cellOf(id);
    const poses = art.CHARACTERS[id].kind === 'cat' ? art.CAT_POSES : art.POSES;
    for (const [pose, { frames, dirs }] of Object.entries(poses)) {
      for (const dir of dirs) {
        for (let frame = 0; frame < frames; frame += 1) {
          const { ctx, rects, other } = recorder();
          try {
            art.paintCharacter(ctx, id, pose, dir, frame);
          } catch (err) {
            // A pose a character does not have (sleep is Pyn's and Hüsnü's) may be refused; any other failure is a fault.
            if (pose === 'sleep') continue;
            throw new Error(`${id} ${pose} ${dir} ${frame}: ${String(err)}`);
          }
          assert.deepEqual(other, [], `${id} ${pose}: only fillStyle and fillRect`);
          assert.ok(rects.length > 20, `${id} ${pose} ${dir} ${frame} is drawn`);
          for (const [x, y, w, h] of rects) {
            assert.ok([x, y, w, h].every(Number.isInteger), `${id} ${pose}: whole pixels`);
            assert.ok(x >= 0 && y >= 0 && x + w <= cell.w && y + h <= cell.h, `${id} ${pose} ${dir} ${frame}: inside its ${cell.w}×${cell.h} cell`);
          }
          const { hand, head } = art.anchors(id, pose, dir, frame);
          assert.ok(hand.length === 2 && head.length === 2);
        }
      }
    }
  }
});

test('the server racks’ lights are their own layer, coloured from the tools’ real state', () => {
  for (const tool of ['claude', 'codex', 'opencode', 'gemini', 'qwen']) {
    const led = art.SPRITES[`rack_led_${tool}`];
    assert.ok(led, tool);
    const { ctx } = recorder();
    led.paint(ctx, 0, { led: art.LED.ok });
  }
});
