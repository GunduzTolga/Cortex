import { strict as assert } from 'node:assert';
import test from 'node:test';
import * as art from '../src/office/office-art.js';
import { loopFrame, nameTheManager, possessive } from '../src/office/ofis-engine.js';

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
  assert.deepEqual(art.MAP.rooms.map((one) => one.id).sort(), ['arsiv', 'dinlenme', 'harita', 'mudur', 'mutfak', 'pyn', 'salon', 'sunucu', 'toplanti']);
  assert.ok(art.MAP.rooms.every((one) => one.tr && one.en));
  assert.deepEqual(art.checkReachability(), [], 'nothing walled in');
});

test('every thing placed and every floor and wall tile has its drawing', () => {
  const missing = art.MAP.objects.filter((one) => !art.SPRITES[one.sprite]).map((one) => one.sprite);
  for (let y = 0; y < art.MAP.h; y += 1) for (let x = 0; x < art.MAP.w; x += 1) for (const name of art.tileSprites(x, y)) if (!art.SPRITES[name]) missing.push(name);
  assert.deepEqual([...new Set(missing)], []);
});

test('the cast: Pyn, the manager, Tolga, twelve agents and Tekir, each at home, the tool agents on their tools', () => {
  const cast = Object.entries(art.CHARACTERS);
  assert.equal(cast.length, 16);
  assert.equal(art.CHARACTERS.mudur.role, 'Müdür', 'named after the vault\'s owner at run time');
  assert.equal(art.CHARACTERS.tolga.name, 'Tolga');
  assert.equal(art.CHARACTERS.tolga.role, 'Yazılımcı', 'the developer who wrote Cortex, at his own desk');
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

test('an animation shows one of its own frames at any time, a clock not yet running included', () => {
  // The first frame of a reopened office can be timed before the loop's start: t was below 0 and
  // the water cooler asked for frame -1, which it does not have.
  for (const t of [-0.004, -1, 0, 0.2, 7.9, 1e6, Number.NaN]) {
    const frame = loopFrame(t, 3, 3, 0.4);
    assert.ok(Number.isInteger(frame) && frame >= 0 && frame < 3, `t=${t}: ${frame}`);
  }
  assert.equal(loopFrame(1, 3, 3), 0);
  assert.equal(loopFrame(1.4, 3, 3), 1);
});

test('the loop keeps its clock: no comment swallows the statements written after it on a line', async () => {
  // A `//` put in the middle of the loop's one-line statements once commented out `this.last = now`:
  // every frame then took the longest step, and the office ran seven times too fast on a 144 Hz screen.
  const { readFileSync } = await import('node:fs');
  const source = readFileSync(new URL('../src/office/ofis-engine.js', import.meta.url), 'utf8');
  for (const statement of ['this.last = now', 'this.t += dt']) {
    const lines = source.split(/\r?\n/).filter((line) => line.includes(statement));
    assert.ok(lines.length > 0, statement);
    for (const line of lines) assert.ok(!line.slice(0, line.indexOf(statement)).includes('//'), `${statement} is code, not a comment: ${line.trim()}`);
  }
});

test('the brain frame: margins on the 16 grid, the map inside, drawn in whole-pixel rectangles and never over the map', () => {
  const { margin, w, h, map } = art.BRAIN;
  for (const side of ['top', 'right', 'bottom', 'left'] as const) assert.equal(margin[side] % 16, 0, side);
  assert.equal(w, art.MAP.w * 16 + margin.left + margin.right);
  assert.equal(h, art.MAP.h * 16 + margin.top + margin.bottom);
  assert.deepEqual(map, { x: margin.left, y: margin.top, w: art.MAP.w * 16, h: art.MAP.h * 16 });
  for (const mode of ['sabah', 'ogle', 'aksam', 'gece'] as const) {
    const { ctx, rects, other } = recorder();
    art.paintBrain(ctx, mode);
    assert.deepEqual(other, [], `${mode}: only fillStyle and fillRect`);
    assert.ok(rects.length > 1000, `${mode} is drawn`);
    for (const [x, y, rw, rh] of rects) {
      assert.ok([x, y, rw, rh].every(Number.isInteger), `${mode}: whole pixels`);
      assert.ok(x >= 0 && y >= 0 && x + rw <= w && y + rh <= h, `${mode}: inside the world`);
      assert.ok(x + rw <= map.x || x >= map.x + map.w || y + rh <= map.y || y >= map.y + map.h, `${mode}: nothing over the map at ${x},${y}`);
    }
  }
});

test('the sparks: every frame in its cell in both colours, by day and by night; their paths stay on the frame, one from every room', () => {
  for (const name of ['kivilcim', 'kivilcim_iz']) {
    const sprite = art.SPRITES[name];
    for (let frame = 0; frame < (sprite.frames ?? 1); frame += 1) {
      for (const pal of [{ renk: 'altin' }, { renk: 'turkuaz' }, { renk: 'altin', gece: true }, { renk: 'turkuaz', gece: true }]) {
        const { ctx, rects, other } = recorder();
        sprite.paint(ctx, frame, pal);
        assert.deepEqual(other, [], `${name} ${frame}: only fillStyle and fillRect`);
        assert.ok(rects.length > 0, `${name} ${frame} is drawn`);
        for (const [x, y, rw, rh] of rects) assert.ok([x, y, rw, rh].every(Number.isInteger) && x >= 0 && y >= 0 && x + rw <= sprite.w && y + rh <= sprite.h, `${name} ${frame}: inside its cell`);
      }
    }
  }
  const { map, w, h, anchors } = art.BRAIN;
  assert.ok(art.NEURON_PATHS.length >= 9);
  for (const path of art.NEURON_PATHS) {
    assert.ok(path.length >= 4 && path.length <= 12, `${path.length} points`);
    for (const [x, y] of path) {
      assert.ok(Number.isInteger(x) && Number.isInteger(y) && x >= 3 && y >= 3 && x < w - 3 && y < h - 3);
      assert.ok(x < map.x - 3 || x >= map.x + map.w + 3 || y < map.y - 3 || y >= map.y + map.h + 3, `off the map: ${x},${y}`);
    }
  }
  assert.deepEqual(Object.keys(anchors).sort(), art.MAP.rooms.map((one) => one.id).sort());
  for (const [room, [x, y]] of Object.entries(anchors)) assert.ok(art.NEURON_PATHS.some((path) => path[0][0] === x && path[0][1] === y), `${room}'s sparks have a path`);
});

test('the manager and their room are named after the vault’s owner; Tolga stays Tolga', () => {
  assert.deepEqual(
    ['Tolga Bey', 'Ayşe', 'Umut', 'Gül', 'Pyn', 'Ali'].map((name) => possessive(name)),
    ["Tolga Bey'in", "Ayşe'nin", "Umut'un", "Gül'ün", "Pyn'in", "Ali'nin"],
  );
  assert.equal(possessive('Tolga', 'en'), "Tolga's");
  assert.equal(possessive(''), '');
  const room = () => art.MAP.rooms.find((one) => one.id === 'mudur');
  nameTheManager(art, 'Tolga Bey', 'tr');
  assert.equal(art.CHARACTERS.mudur.name, 'Tolga Bey');
  assert.equal(room()?.tr, "TOLGA BEY'İN ODASI");
  assert.equal(room()?.en, "TOLGA BEY'S OFFICE");
  nameTheManager(art, null, 'en');
  assert.equal(art.CHARACTERS.mudur.name, 'Manager');
  assert.equal(room()?.tr, 'MÜDÜR ODASI');
  assert.equal(art.CHARACTERS.tolga.name, 'Tolga', 'the developer who wrote Cortex, whoever owns the vault');
});
