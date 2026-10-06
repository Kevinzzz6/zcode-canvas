// Follows ZCode's JSONL event log for the desktop pet. Kept free of electron imports so it can be
// tested outside ZCode. Read-only: it never writes, locks or rotates ZCode's files.
import { closeSync, openSync, readSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** Where ZCode writes it (adapters/src/logging): ZCODE_LOG_DIR, else ~/.zcode/cli/log. */
export function zcodeLogDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.ZCODE_LOG_DIR || join(homedir(), ".zcode", "cli", "log");
}

/** One file per local calendar day, as ZCode names them. */
export function zcodeLogFile(dir: string, date: Date): string {
  const day = [date.getFullYear().toString().padStart(4, "0"), (date.getMonth() + 1).toString().padStart(2, "0"), date.getDate().toString().padStart(2, "0")].join("-");
  return join(dir, `zcode-${day}.jsonl`);
}

/** At most this much is read per poll; a bigger backlog is skipped, it describes the past anyway. */
const MAX_READ = 1024 * 1024;
const NEWLINE = 0x0a;

interface LogTail {
  /** Reads whatever was appended since the last call and hands over complete lines. */
  poll(now?: Date): void;
}

/**
 * Starts at the end of today's file: the pet reflects what happens from now on, not a replay of
 * the day. A new day's file is read from its start; a file that shrank was replaced and is reread.
 */
export function createLogTail(dir: string, onLine: (line: string) => void): LogTail {
  let file: string | null = null;
  let offset = 0;
  /** Bytes after the last newline: a line ZCode is still writing. */
  let rest = Buffer.alloc(0);
  /** After skipping ahead, the first line read is a fragment. */
  let skipFirst = false;

  const size = (path: string) => statSync(path, { throwIfNoEntry: false })?.size ?? null;

  function restart(at: number, fragment: boolean) {
    offset = at;
    rest = Buffer.alloc(0);
    skipFirst = fragment;
  }

  function emit(bytes: Buffer) {
    const data = rest.length ? Buffer.concat([rest, bytes]) : bytes;
    let start = 0;
    for (let index = data.indexOf(NEWLINE); index !== -1; index = data.indexOf(NEWLINE, start)) {
      const text = data.subarray(start, index).toString("utf8");
      start = index + 1;
      if (skipFirst) skipFirst = false;
      else if (text) onLine(text);
    }
    rest = Buffer.from(data.subarray(start));
  }

  function drain(path: string) {
    const end = size(path);
    if (end === null) return;
    if (end < offset) restart(0, false);
    if (end - offset > MAX_READ) restart(end - MAX_READ, true);
    if (end === offset) return;
    const chunk = Buffer.alloc(end - offset);
    const fd = openSync(path, "r");
    try {
      const read = readSync(fd, chunk, 0, chunk.length, offset);
      offset += read;
      emit(chunk.subarray(0, read));
    } finally {
      closeSync(fd);
    }
  }

  return {
    poll(now = new Date()) {
      const today = zcodeLogFile(dir, now);
      if (file === null) {
        file = today;
        restart(size(today) ?? 0, false);
        return;
      }
      if (file !== today) {
        // Finish yesterday's file (an agent working across midnight), then follow the new one.
        drain(file);
        file = today;
        restart(0, false);
      }
      drain(file);
    },
  };
}
