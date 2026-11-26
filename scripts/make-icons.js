// Renders the PWA icons (src/views/icons/*.png) from the same design as favicon.svg, with no dependencies.
// Run with: node scripts/make-icons.js   (only needed if the logo changes; the PNGs are committed)
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const SAMPLES = 4; // 4x4 supersampling for smooth edges
const BLUE = [37, 99, 235];
const STROKE = 0.9; // half of the 1.8 stroke width in the 24-unit design

// Signed distance from p to a rounded rectangle with centre c, half-size h and corner radius r
function roundRect(px, py, cx, cy, hx, hy, r) {
    const qx = Math.abs(px - cx) - (hx - r);
    const qy = Math.abs(py - cy) - (hy - r);
    return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r;
}

function segmentDistance(px, py, ax, ay, bx, by) {
    const dx = bx - ax;
    const dy = by - ay;
    const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)));
    return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

// Is the (24-unit) point part of the white envelope?
function inEnvelope(x, y) {
    if (Math.abs(roundRect(x, y, 12, 12, 7, 5, 1)) <= STROKE) return true;
    return (
        segmentDistance(x, y, 19, 8.5, 12, 13) <= STROKE ||
        segmentDistance(x, y, 12, 13, 5, 8.5) <= STROKE
    );
}

// kind 'any': rounded square on a transparent background. 'full': full-bleed square, with the envelope
// shrunk into the centre so a maskable icon survives any mask shape (or iOS rounding).
function render(size, kind) {
    const scale = kind === 'full' ? 0.72 : 1;
    const raw = Buffer.alloc(size * (size * 4 + 1));
    for (let y = 0; y < size; y++) {
        raw[y * (size * 4 + 1)] = 0; // PNG filter: none
        for (let x = 0; x < size; x++) {
            let bg = 0;
            let fg = 0;
            for (let sy = 0; sy < SAMPLES; sy++) {
                for (let sx = 0; sx < SAMPLES; sx++) {
                    const ux = ((x + (sx + 0.5) / SAMPLES) / size) * 24;
                    const uy = ((y + (sy + 0.5) / SAMPLES) / size) * 24;
                    const inBg = kind === 'full' || roundRect(ux, uy, 12, 12, 12, 12, 6) <= 0;
                    if (!inBg) continue;
                    bg++;
                    if (inEnvelope(12 + (ux - 12) / scale, 12 + (uy - 12) / scale)) fg++;
                }
            }
            const total = SAMPLES * SAMPLES;
            const o = y * (size * 4 + 1) + 1 + x * 4;
            const white = bg ? fg / bg : 0;
            for (let c = 0; c < 3; c++) raw[o + c] = Math.round(BLUE[c] * (1 - white) + 255 * white);
            raw[o + 3] = Math.round((bg / total) * 255);
        }
    }
    return raw;
}

const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
});
function crc32(buf) {
    let c = 0xffffffff;
    for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
    const body = Buffer.concat([Buffer.from(type), data]);
    const out = Buffer.alloc(body.length + 8);
    out.writeUInt32BE(data.length, 0);
    body.copy(out, 4);
    out.writeUInt32BE(crc32(body), body.length + 4);
    return out;
}
function png(size, kind) {
    const header = Buffer.alloc(13);
    header.writeUInt32BE(size, 0);
    header.writeUInt32BE(size, 4);
    header[8] = 8; // bit depth
    header[9] = 6; // RGBA
    return Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        chunk('IHDR', header),
        chunk('IDAT', zlib.deflateSync(render(size, kind), { level: 9 })),
        chunk('IEND', Buffer.alloc(0)),
    ]);
}

const outDir = path.join(__dirname, '..', 'src', 'views', 'icons');
fs.mkdirSync(outDir, { recursive: true });
const icons = [
    ['icon-192.png', 192, 'any'],
    ['icon-512.png', 512, 'any'],
    ['icon-maskable-512.png', 512, 'full'],
    ['apple-touch-icon.png', 180, 'full'],
];
for (const [name, size, kind] of icons) {
    fs.writeFileSync(path.join(outDir, name), png(size, kind));
    console.log(`wrote ${name}`);
}
