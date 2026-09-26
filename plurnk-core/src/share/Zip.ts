import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, join, relative, sep } from "node:path";
import { crc32, deflateRawSync } from "node:zlib";

// {§share}: one folder as a ZIP archive whose single top-level entry is that folder (PKWARE APPNOTE
// 6.3.10: local headers, deflated data, central directory, end record), built on node:zlib alone.
// ZIP64 is not written: an archive past its 65,535 entries or 4 GiB fails instead of truncating.
export default class Zip {
    static writeFolder(folder: string, target: string): void {
        const root = basename(folder);
        const files = Zip.#files(folder).toSorted();
        if (files.length > 0xffff) throw new Error(`zip: ${folder} holds ${files.length} files; the archive format allows 65,535`);
        const parts: Buffer[] = [];
        const directory: Buffer[] = [];
        let offset = 0;
        for (const file of files) {
            const name = Buffer.from(`${root}/${relative(folder, file).split(sep).join("/")}`, "utf8");
            const data = readFileSync(file);
            const packed = deflateRawSync(data);
            const checksum = crc32(data);
            const [time, date] = Zip.#dosStamp(statSync(file).mtime);
            const local = Buffer.alloc(30);
            local.writeUInt32LE(0x04034b50, 0);
            local.writeUInt16LE(20, 4);
            local.writeUInt16LE(0x0800, 6);
            local.writeUInt16LE(8, 8);
            local.writeUInt16LE(time, 10);
            local.writeUInt16LE(date, 12);
            local.writeUInt32LE(checksum, 14);
            local.writeUInt32LE(packed.length, 18);
            local.writeUInt32LE(data.length, 22);
            local.writeUInt16LE(name.length, 26);
            const central = Buffer.alloc(46);
            central.writeUInt32LE(0x02014b50, 0);
            central.writeUInt16LE(20, 4);
            central.writeUInt16LE(20, 6);
            central.writeUInt16LE(0x0800, 8);
            central.writeUInt16LE(8, 10);
            central.writeUInt16LE(time, 12);
            central.writeUInt16LE(date, 14);
            central.writeUInt32LE(checksum, 16);
            central.writeUInt32LE(packed.length, 20);
            central.writeUInt32LE(data.length, 24);
            central.writeUInt16LE(name.length, 28);
            central.writeUInt32LE(offset, 42);
            parts.push(local, name, packed);
            directory.push(central, name);
            offset += local.length + name.length + packed.length;
            // 0xffff_ffff: the format's 32-bit offset field, not a setting.
            if (offset > 0xffff_ffff) throw new Error(`zip: ${folder} exceeds the archive format's 4 GiB`);
        }
        const central = Buffer.concat(directory);
        const end = Buffer.alloc(22);
        end.writeUInt32LE(0x06054b50, 0);
        end.writeUInt16LE(files.length, 8);
        end.writeUInt16LE(files.length, 10);
        end.writeUInt32LE(central.length, 12);
        end.writeUInt32LE(offset, 16);
        writeFileSync(target, Buffer.concat([...parts, central, end]));
    }

    static #files(folder: string): string[] {
        return readdirSync(folder, { withFileTypes: true }).flatMap((entry) => {
            const path = join(folder, entry.name);
            return entry.isDirectory() ? Zip.#files(path) : entry.isFile() ? [path] : [];
        });
    }

    // MS-DOS date and time fields, local time, two-second resolution.
    static #dosStamp(when: Date): [number, number] {
        const time = (when.getHours() << 11) | (when.getMinutes() << 5) | (when.getSeconds() >> 1);
        const date = ((Math.max(when.getFullYear(), 1980) - 1980) << 9) | ((when.getMonth() + 1) << 5) | when.getDate();
        return [time, date];
    }
}
