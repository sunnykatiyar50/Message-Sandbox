const zlib = require('zlib');

// A minimal ZIP writer: every entry is stored (not compressed), which is plenty for .eml files and keeps this
// free of dependencies. Names are UTF-8. Needs Node 22.2+ for zlib.crc32.

// Seconds-resolution DOS date/time from a Date (ZIP's native format)
function dosDateTime(date) {
    const d = Number.isNaN(date.getTime()) ? new Date() : date;
    const time = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
    const day = (Math.max(d.getFullYear(), 1980) - 1980 << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
    return { time, day };
}

// entries: [{ name, data: Buffer, date?: Date }] -> Buffer
function createZip(entries) {
    const parts = [];
    const central = [];
    let offset = 0;

    for (const entry of entries) {
        const name = Buffer.from(entry.name, 'utf8');
        const crc = zlib.crc32(entry.data);
        const { time, day } = dosDateTime(entry.date || new Date());

        const local = Buffer.alloc(30);
        local.writeUInt32LE(0x04034b50, 0); // local file header
        local.writeUInt16LE(20, 4); // version needed
        local.writeUInt16LE(0x0800, 6); // flags: UTF-8 names
        local.writeUInt16LE(0, 8); // method: stored
        local.writeUInt16LE(time, 10);
        local.writeUInt16LE(day, 12);
        local.writeUInt32LE(crc, 14);
        local.writeUInt32LE(entry.data.length, 18); // compressed size
        local.writeUInt32LE(entry.data.length, 22); // uncompressed size
        local.writeUInt16LE(name.length, 26);
        local.writeUInt16LE(0, 28); // extra field length
        parts.push(local, name, entry.data);

        const header = Buffer.alloc(46);
        header.writeUInt32LE(0x02014b50, 0); // central directory header
        header.writeUInt16LE(20, 4); // version made by
        header.writeUInt16LE(20, 6); // version needed
        header.writeUInt16LE(0x0800, 8);
        header.writeUInt16LE(0, 10);
        header.writeUInt16LE(time, 12);
        header.writeUInt16LE(day, 14);
        header.writeUInt32LE(crc, 16);
        header.writeUInt32LE(entry.data.length, 20);
        header.writeUInt32LE(entry.data.length, 24);
        header.writeUInt16LE(name.length, 28);
        header.writeUInt32LE(offset, 42); // where the local header starts
        central.push(header, name);

        offset += local.length + name.length + entry.data.length;
    }

    const directory = Buffer.concat(central);
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0); // end of central directory
    end.writeUInt16LE(entries.length, 8);
    end.writeUInt16LE(entries.length, 10);
    end.writeUInt32LE(directory.length, 12);
    end.writeUInt32LE(offset, 16);
    return Buffer.concat([...parts, directory, end]);
}

module.exports = { createZip };
