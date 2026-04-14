import { EventEmitter } from "events";
import { writeFileSync, readFileSync, mkdirSync, existsSync } from "fs";
import { join } from "path";

export type SyncType = "inventory" | "prices" | "customers" | "reconcile";

export interface SyncJob {
  id: string;
  type: SyncType;
  status: "running" | "done" | "error";
  logs: string[];
  emitter: EventEmitter;
  startedAt: Date;
  finishedAt?: Date;
}

export interface PersistedReport {
  id: string;
  type: SyncType;
  status: "done" | "error";
  logs: string[];
  startedAt: string;
  finishedAt: string;
}

// ─── In-memory stores ──────────────────────────────────────────────────────
const jobs = new Map<string, SyncJob>();
const lastJobByType = new Map<SyncType, SyncJob>();
const JOB_TTL_MS = 8 * 60 * 60 * 1000; // 8 hours

// ─── Disk persistence ──────────────────────────────────────────────────────
// Reports are saved to .data/qb-reports/<type>-last-report.json
// This survives server restarts.
const REPORTS_DIR = join(process.cwd(), ".data", "qb-reports");

function ensureDir() {
  if (!existsSync(REPORTS_DIR)) {
    mkdirSync(REPORTS_DIR, { recursive: true });
  }
}

function reportPath(type: SyncType): string {
  return join(REPORTS_DIR, `${type}-last-report.json`);
}

function persistToDisk(job: SyncJob) {
  try {
    ensureDir();
    const data: PersistedReport = {
      id: job.id,
      type: job.type,
      status: job.status as "done" | "error",
      logs: job.logs,
      startedAt: job.startedAt.toISOString(),
      finishedAt: (job.finishedAt || new Date()).toISOString(),
    };
    writeFileSync(reportPath(job.type), JSON.stringify(data, null, 2), "utf8");
  } catch (err) {
    console.warn("[QB] Failed to persist job report to disk:", err);
  }
}

export function loadPersistedReport(type: SyncType): PersistedReport | null {
  try {
    const file = reportPath(type);
    if (!existsSync(file)) return null;
    return JSON.parse(readFileSync(file, "utf8")) as PersistedReport;
  } catch {
    return null;
  }
}

// ─── Job management ────────────────────────────────────────────────────────

export function createSyncJob(type: SyncType): SyncJob {
  const id = `${type}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const job: SyncJob = {
    id,
    type,
    status: "running",
    logs: [],
    emitter: new EventEmitter(),
    startedAt: new Date(),
  };
  job.emitter.setMaxListeners(20);
  jobs.set(id, job);
  lastJobByType.set(type, job);

  // Auto-cleanup from the active jobs map after TTL
  // (lastJobByType keeps its ref; disk also keeps the data)
  setTimeout(() => jobs.delete(id), JOB_TTL_MS);

  return job;
}

export function getSyncJob(id: string): SyncJob | undefined {
  return jobs.get(id);
}

export function getLastJobByType(type: SyncType): SyncJob | undefined {
  return lastJobByType.get(type);
}

export function appendLog(job: SyncJob, line: string) {
  job.logs.push(line);
  job.emitter.emit("log", line);
}

export function finishJob(job: SyncJob, status: "done" | "error") {
  job.status = status;
  job.finishedAt = new Date();
  job.emitter.emit("done", status);

  // Persist to disk so reports survive server restarts
  persistToDisk(job);
}
