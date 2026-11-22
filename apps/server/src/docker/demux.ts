/** Docker answers an attached exec with multiplexed frames (8-byte header: type, padding, big-endian length). */
export function demuxOutput(buf: Buffer): { stdout: string; stderr: string } {
  const out: Buffer[] = [];
  const err: Buffer[] = [];
  let i = 0;
  while (i + 8 <= buf.length) {
    const type = buf[i];
    const len = buf.readUInt32BE(i + 4);
    const start = i + 8;
    const end = start + len;
    if (end > buf.length) break; // a truncated frame: keep what is complete
    (type === 2 ? err : out).push(buf.subarray(start, end));
    i = end;
  }
  // A stream without frame headers (a TTY container) is plain text.
  if (i === 0 && buf.length) out.push(buf);
  return { stdout: Buffer.concat(out).toString('utf8'), stderr: Buffer.concat(err).toString('utf8') };
}

