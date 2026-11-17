// STL reader (binary and ASCII). Returns flat triangle vertices: 9 numbers per triangle, file units.

export function parseSTL(buf: ArrayBuffer): Float32Array {
  const bytes = buf.byteLength;
  const dv = new DataView(buf);
  if (bytes >= 84) {
    const n = dv.getUint32(80, true);
    if (n > 0 && 84 + n * 50 === bytes) return readBinary(dv, n);
  }
  const head = new TextDecoder().decode(new Uint8Array(buf, 0, Math.min(bytes, 512))).trimStart();
  if (head.startsWith("solid")) {
    const tris = readAscii(new TextDecoder().decode(buf));
    if (tris.length >= 36) return tris;
  }
  // Binary file with a wrong triangle count or trailing bytes.
  if (bytes >= 84 + 50) {
    const n = Math.min(dv.getUint32(80, true), Math.floor((bytes - 84) / 50));
    if (n >= 4) return readBinary(dv, n);
  }
  throw new Error("This file is not a readable STL mesh.");
}

function readBinary(dv: DataView, n: number): Float32Array {
  const out = new Float32Array(n * 9);
  let o = 0;
  for (let i = 0; i < n; i++) {
    const p = 84 + i * 50 + 12;
    for (let k = 0; k < 9; k++) out[o++] = dv.getFloat32(p + k * 4, true);
  }
  return validate(out);
}

function readAscii(text: string): Float32Array {
  const re = /vertex\s+([-+\d.eE]+)\s+([-+\d.eE]+)\s+([-+\d.eE]+)/g;
  const v: number[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) v.push(+m[1], +m[2], +m[3]);
  v.length -= v.length % 9;
  return validate(new Float32Array(v));
}

function validate(t: Float32Array): Float32Array {
  if (t.length < 36) throw new Error("The STL needs at least 4 triangles.");
  for (let i = 0; i < t.length; i++) if (!Number.isFinite(t[i])) throw new Error("The STL contains invalid coordinates.");
  return t;
}

/** Binary STL writer, used for the built-in example and tests. */
export function writeSTL(tris: Float32Array): ArrayBuffer {
  const n = tris.length / 9;
  const buf = new ArrayBuffer(84 + n * 50);
  const dv = new DataView(buf);
  dv.setUint32(80, n, true);
  for (let i = 0; i < n; i++) {
    const p = 84 + i * 50 + 12;
    for (let k = 0; k < 9; k++) dv.setFloat32(p + k * 4, tris[i * 9 + k], true);
  }
  return buf;
}
