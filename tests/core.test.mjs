// Unit tests for the pure CORE block of index.html. Run: node --test tests/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const src = html.slice(html.indexOf('// CORE-START'), html.indexOf('// CORE-END'));
const Core = new Function(`${src}; return Core;`)();

test('frameAtTime inverts timeForFrame for every frame (no float drift)', () => {
  for (const fps of [24, 25, 29.97, 30, 59.94, 60, 120, 240]) {
    for (let f = 0; f < 5000; f++) {
      assert.equal(Core.frameAtTime(Core.timeForFrame(f, fps), fps), f, `fps ${fps} frame ${f}`);
    }
  }
});

test('flight frames use the last-ground / first-ground convention', () => {
  // takeoff = last ground frame 10, landing = first ground frame 26 → 15 airborne frames
  assert.equal(Core.flightFrames(10, 26), 15);
  assert.equal(Core.contactFrames(5, 10), 6);
});

test('height from flight time matches h = g t^2 / 8', () => {
  assert.ok(Math.abs(Core.heightFromFlight(0.5) - 30.656) < 0.001);
});

test('jumpMeasure: slowed 240fps export counted on a 30fps timeline', () => {
  // 0.5 s real flight shot at 240 fps = 120 airborne frames, regardless of timeline rate
  const m = Core.jumpMeasure(100, 221, 240);
  assert.equal(m.frames, 120);
  assert.ok(Math.abs(m.flightTime - 0.5) < 1e-9);
  assert.ok(Math.abs(m.cm - 30.656) < 0.001);
  assert.ok(m.cmLow < m.cm && m.cm < m.cmHigh);
});

test('jumpMeasure: precision bound shrinks with fps', () => {
  const at30 = Core.jumpMeasure(0, 16, 30);   // 15 frames = 0.5 s
  const at240 = Core.jumpMeasure(0, 121, 240); // 120 frames = 0.5 s
  assert.ok(at30.plusMinus > 3.5 && at30.plusMinus < 4.5, `30fps ±${at30.plusMinus}`);
  assert.ok(at240.plusMinus < 0.6, `240fps ±${at240.plusMinus}`);
});

test('effectiveCaptureFps never goes below timeline fps', () => {
  assert.equal(Core.effectiveCaptureFps(30, 240), 240);
  assert.equal(Core.effectiveCaptureFps(240, 30), 240);
  assert.equal(Core.effectiveCaptureFps(30, 29.97), 30);
  assert.equal(Core.effectiveCaptureFps(NaN, 60), 60);
});

test('snapFps snaps near-common rates only', () => {
  assert.equal(Core.snapFps(29.98), 29.97);
  assert.equal(Core.snapFps(238.5), 239.76);
  assert.equal(Core.snapFps(37.3), 37.3);
});

// --- minimal ISO BMFF builder ---
const box = (type, ...payloads) => {
  const body = Buffer.concat(payloads.map(p => Buffer.isBuffer(p) ? p : Buffer.from(p)));
  const h = Buffer.alloc(8); h.writeUInt32BE(8 + body.length, 0); h.write(type, 4, 'latin1');
  return Buffer.concat([h, body]);
};
const u32 = (...v) => { const b = Buffer.alloc(4 * v.length); v.forEach((x, i) => b.writeUInt32BE(x, 4 * i)); return b; };
const trak = (handler, timescale, runs) => box('trak',
  box('mdia',
    box('mdhd', u32(0, 0, 0, timescale, 0, 0)),
    box('hdlr', u32(0, 0), Buffer.from(handler, 'latin1'), u32(0, 0, 0), Buffer.from([0])),
    box('minf', box('stbl', box('stts', u32(0, runs.length, ...runs.flat()))))));
const reader = buf => async (off, len) => new Uint8Array(buf.subarray(off, Math.min(buf.length, off + len)));

test('mp4VideoFps reads the video track (moov at end, audio track first)', async () => {
  const file = Buffer.concat([
    box('ftyp', 'qt  ', u32(0)),
    box('mdat', Buffer.alloc(5000)),
    box('moov', trak('soun', 44100, [[100, 1024]]), trak('vide', 600, [[1, 21], [900, 20], [3, 19]])),
  ]);
  assert.equal(await Core.mp4VideoFps(reader(file), file.length), 30);
});

test('mp4VideoFps: 240fps iPhone-style timeline', async () => {
  const file = Buffer.concat([box('moov', trak('vide', 2400, [[2400, 10]])), box('mdat', Buffer.alloc(10))]);
  assert.equal(await Core.mp4VideoFps(reader(file), file.length), 240);
});

test('mp4VideoFps returns null for non-mp4 data', async () => {
  const junk = Buffer.from('\x1aE\xdf\xa3 not an mp4 file at all', 'latin1');
  assert.equal(await Core.mp4VideoFps(reader(junk), junk.length), null);
});

test('detectEvents finds takeoff/landing spikes', () => {
  const data = new Array(200).fill(1);
  for (let i = 50; i < 56; i++) data[i] = 20; // takeoff burst
  for (let i = 120; i < 126; i++) data[i] = 25; // landing impact
  const d = Core.detectEvents(data, 'CMJ');
  assert.ok(d && d.takeoff >= 48 && d.takeoff <= 57 && d.landing >= 118 && d.landing <= 127, JSON.stringify(d));
});
