import { createWriteStream, readdirSync, unlinkSync, mkdirSync, WriteStream } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const LOG_DIR = process.env.MCP_REMINDERS_LOG_DIR || join(dirname(__dirname), "logs");
const RETENTION_DAYS = 7;

let currentDate = "";
let stream: WriteStream | null = null;

function dateStr(d: Date = new Date()): string {
  return d.toISOString().slice(0, 10);
}

function timestamp(): string {
  return new Date().toISOString();
}

function logPath(date: string): string {
  return join(LOG_DIR, `mcp-reminder-${date}.log`);
}

function ensureStream(): WriteStream {
  const today = dateStr();
  if (today !== currentDate || !stream) {
    if (stream) stream.end();
    currentDate = today;
    mkdirSync(LOG_DIR, { recursive: true });
    stream = createWriteStream(logPath(today), { flags: "a" });
    pruneOldLogs();
  }
  return stream;
}

function pruneOldLogs(): void {
  try {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - RETENTION_DAYS);
    const cutoffStr = dateStr(cutoff);
    const files = readdirSync(LOG_DIR).filter(
      (f) => f.startsWith("mcp-reminder-") && f.endsWith(".log")
    );
    for (const file of files) {
      const fileDate = file.replace("mcp-reminder-", "").replace(".log", "");
      if (fileDate < cutoffStr) {
        unlinkSync(join(LOG_DIR, file));
      }
    }
  } catch {
    // best-effort cleanup
  }
}

function write(level: string, msg: string): void {
  const s = ensureStream();
  s.write(`${timestamp()} [${level}] ${msg}\n`);
}

export const log = {
  info: (msg: string) => write("INFO", msg),
  warn: (msg: string) => write("WARN", msg),
  error: (msg: string) => write("ERROR", msg),
};

// Check for date rollover every 60s
setInterval(() => ensureStream(), 60_000).unref();
