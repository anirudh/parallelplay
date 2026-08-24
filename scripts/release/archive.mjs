import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readlinkSync, readdirSync } from "node:fs";
import { basename, posix, relative, resolve } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";

function octal(value, width) {
  return value.toString(8).padStart(width - 1, "0") + "\0";
}

function writeString(buffer, offset, length, value) {
  Buffer.from(value).copy(buffer, offset, 0, length);
}

function paxRecord(key, value) {
  let length = Buffer.byteLength(`${key}=${value}\n`) + 3;
  while (true) {
    const record = `${String(length)} ${key}=${value}\n`;
    const actual = Buffer.byteLength(record);
    if (actual === length) return record;
    length = actual;
  }
}

function splitUstarPath(path) {
  if (Buffer.byteLength(path) <= 100) return { name: path, prefix: "" };
  for (let index = path.lastIndexOf("/"); index > 0; index = path.lastIndexOf("/", index - 1)) {
    const prefix = path.slice(0, index);
    const name = path.slice(index + 1);
    if (Buffer.byteLength(prefix) <= 155 && Buffer.byteLength(name) <= 100) return { name, prefix };
  }
  return null;
}

function header(path, size, mode, type, linkname, epoch) {
  const split = splitUstarPath(path) ?? { name: basename(path).slice(0, 100), prefix: "" };
  const buffer = Buffer.alloc(512);
  writeString(buffer, 0, 100, split.name);
  writeString(buffer, 100, 8, octal(mode, 8));
  writeString(buffer, 108, 8, octal(0, 8));
  writeString(buffer, 116, 8, octal(0, 8));
  writeString(buffer, 124, 12, octal(size, 12));
  writeString(buffer, 136, 12, octal(epoch, 12));
  buffer.fill(0x20, 148, 156);
  writeString(buffer, 156, 1, type);
  writeString(buffer, 157, 100, linkname ?? "");
  writeString(buffer, 257, 6, "ustar\0");
  writeString(buffer, 263, 2, "00");
  writeString(buffer, 265, 32, "root");
  writeString(buffer, 297, 32, "root");
  writeString(buffer, 329, 8, octal(0, 8));
  writeString(buffer, 337, 8, octal(0, 8));
  writeString(buffer, 345, 155, split.prefix);
  const checksum = [...buffer].reduce((sum, byte) => sum + byte, 0);
  writeString(buffer, 148, 8, `${checksum.toString(8).padStart(6, "0")}\0 `);
  return buffer;
}

function padded(data) {
  const remainder = data.length % 512;
  return remainder === 0 ? data : Buffer.concat([data, Buffer.alloc(512 - remainder)]);
}

export function createTarGz(entries, epoch) {
  const chunks = [];
  for (const entry of [...entries].sort((left, right) => left.path.localeCompare(right.path))) {
    const path = entry.path.replaceAll("\\", "/").replace(/^\.\//, "");
    if (!path || path.startsWith("/") || path.split("/").includes("..")) {
      throw new Error(`Unsafe archive path: ${entry.path}`);
    }
    const pax = [];
    if (!splitUstarPath(path)) pax.push(paxRecord("path", path));
    if (entry.type === "symlink" && Buffer.byteLength(entry.linkname) > 100) {
      pax.push(paxRecord("linkpath", entry.linkname));
    }
    if (pax.length) {
      const data = Buffer.from(pax.join(""));
      const paxName = `PaxHeaders/${createHash("sha256").update(path).digest("hex").slice(0, 32)}`;
      chunks.push(header(paxName, data.length, 0o644, "x", "", epoch), padded(data));
    }
    if (entry.type === "symlink") {
      chunks.push(header(path, 0, 0o777, "2", entry.linkname.slice(0, 100), epoch));
    } else {
      chunks.push(
        header(path, entry.data.length, entry.mode ?? 0o644, "0", "", epoch),
        padded(entry.data)
      );
    }
  }
  chunks.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(chunks), { level: 9, mtime: 0 });
}

export function memoryEntry(path, value, mode = 0o644) {
  return { type: "file", path, data: Buffer.isBuffer(value) ? value : Buffer.from(value), mode };
}

export function directoryEntries(root, prefix, options = {}) {
  const absoluteRoot = resolve(root);
  const entries = [];
  function visit(directory) {
    for (const item of readdirSync(directory, { withFileTypes: true }).sort((a, b) =>
      a.name.localeCompare(b.name)
    )) {
      const absolute = resolve(directory, item.name);
      const local = relative(absoluteRoot, absolute).replaceAll("\\", "/");
      if (options.exclude?.(local)) continue;
      const archivePath = posix.join(prefix, local);
      const stat = lstatSync(absolute);
      if (stat.isDirectory()) visit(absolute);
      else if (stat.isSymbolicLink()) {
        const linkname = readlinkSync(absolute);
        const resolvedTarget = resolve(directory, linkname);
        if (!resolvedTarget.startsWith(`${absoluteRoot}/`))
          throw new Error(`Archive symlink escapes root: ${local}`);
        entries.push({ type: "symlink", path: archivePath, linkname });
      } else if (stat.isFile()) {
        const transform = options.transform?.(local, readFileSync(absolute));
        entries.push(
          memoryEntry(
            archivePath,
            transform ?? readFileSync(absolute),
            stat.mode & 0o111 ? 0o755 : 0o644
          )
        );
      }
    }
  }
  visit(absoluteRoot);
  return entries;
}

function readNullTerminated(buffer) {
  const zero = buffer.indexOf(0);
  return buffer.subarray(0, zero < 0 ? buffer.length : zero).toString("utf8");
}

export function readTar(bytes) {
  const tar = bytes;
  const entries = [];
  let offset = 0;
  let pax = {};
  while (offset + 512 <= tar.length) {
    const block = tar.subarray(offset, offset + 512);
    if (block.every((value) => value === 0)) break;
    const name = readNullTerminated(block.subarray(0, 100));
    const prefix = readNullTerminated(block.subarray(345, 500));
    const size = Number.parseInt(readNullTerminated(block.subarray(124, 136)).trim() || "0", 8);
    const type = String.fromCharCode(block[156] || 48);
    const linkname = readNullTerminated(block.subarray(157, 257));
    const dataStart = offset + 512;
    const data = tar.subarray(dataStart, dataStart + size);
    offset = dataStart + Math.ceil(size / 512) * 512;
    if (type === "x") {
      pax = {};
      let cursor = 0;
      while (cursor < data.length) {
        const space = data.indexOf(0x20, cursor);
        if (space < 0) break;
        const length = Number(data.subarray(cursor, space).toString("utf8"));
        const record = data.subarray(space + 1, cursor + length - 1).toString("utf8");
        const equals = record.indexOf("=");
        if (equals > 0) pax[record.slice(0, equals)] = record.slice(equals + 1);
        cursor += length;
      }
      continue;
    }
    entries.push({
      path: pax.path ?? (prefix ? `${prefix}/${name}` : name),
      type: type === "2" ? "symlink" : "file",
      linkname: pax.linkpath ?? linkname,
      data: Buffer.from(data)
    });
    pax = {};
  }
  return entries;
}

export function readTarGz(bytes) {
  return readTar(gunzipSync(bytes));
}
