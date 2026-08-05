// ─────────────────────────────────────────────────────────────────────────────
// sync/scheduler.ts — Runtime v2 upload/download scheduler
// ─────────────────────────────────────────────────────────────────────────────
// Deliberately boring coordination: one timer for upload, one for download,
// both workers already single-flight. No entity knowledge belongs here.
//
// Intervals are runtime configuration, not correctness guarantees. A worker
// always resumes from durable event delivery/cursor state after restart.
// ─────────────────────────────────────────────────────────────────────────────

import { uploadPendingEvents, getUploadWorkerState, type UploadSummary } from "./uploadWorker.ts";
import { downloadCloudChanges, getDownloadWorkerState, type DownloadSummary } from "./downloadWorker.ts";

const DEFAULT_UPLOAD_INTERVAL_MS = 5_000;
const DEFAULT_DOWNLOAD_INTERVAL_MS = 15_000;

let uploadTimer: ReturnType<typeof setInterval> | null = null;
let downloadTimer: ReturnType<typeof setInterval> | null = null;
let started = false;
let lastUpload: UploadSummary | null = null;
let lastDownload: DownloadSummary | null = null;
let uploadInProgress: Promise<UploadSummary> | null = null;
let downloadInProgress: Promise<DownloadSummary> | null = null;

export interface SchedulerOptions {
  uploadIntervalMs?: number;
  downloadIntervalMs?: number;
  runImmediately?: boolean;
}

export function startSyncV2Scheduler(options: SchedulerOptions = {}): void {
  if (started) return;
  started = true;

  const uploadInterval = boundedInterval(options.uploadIntervalMs, DEFAULT_UPLOAD_INTERVAL_MS);
  const downloadInterval = boundedInterval(options.downloadIntervalMs, DEFAULT_DOWNLOAD_INTERVAL_MS);

  const runUpload = () => {
    uploadInProgress = uploadPendingEvents().then((result) => {
      lastUpload = result;
      return result;
    }).finally(() => {
      uploadInProgress = null;
    });
  };
  const runDownload = () => {
    downloadInProgress = downloadCloudChanges().then((result) => {
      lastDownload = result;
      return result;
    }).finally(() => {
      downloadInProgress = null;
    });
  };

  uploadTimer = setInterval(runUpload, uploadInterval);
  downloadTimer = setInterval(runDownload, downloadInterval);

  if (options.runImmediately !== false) {
    runUpload();
    runDownload();
  }
}

export function stopSyncV2Scheduler(): void {
  if (uploadTimer) clearInterval(uploadTimer);
  if (downloadTimer) clearInterval(downloadTimer);
  uploadTimer = null;
  downloadTimer = null;
  started = false;
}

export function getSyncV2SchedulerStatus() {
  return {
    started,
    uploadRunning: uploadInProgress !== null || getUploadWorkerState().running,
    downloadRunning: downloadInProgress !== null || getDownloadWorkerState().running,
    lastUpload,
    lastDownload,
  };
}

function boundedInterval(value: number | undefined, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(Math.max(Math.floor(value as number), 1000), 60 * 60 * 1000);
}
