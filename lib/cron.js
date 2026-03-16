import cron from 'node-cron';
import { readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { getHomePath, loadConfig } from './config.js';

const JOBS_PATH = join(loadConfig().workspacePath, 'cron/jobs.json');
const RUNS_DIR = getHomePath('cron/runs');

const tasks = [];

export function loadJobs() {
  if (!existsSync(JOBS_PATH)) return [];
  const data = JSON.parse(readFileSync(JOBS_PATH, 'utf8'));
  return data.jobs || [];
}

/**
 * Start the cron scheduler. Registers all enabled jobs.
 * @param {Function} handleMessage - async (channel, content, meta) => response
 */
export function startScheduler(handleMessage) {
  const jobs = loadJobs();

  for (const job of jobs) {
    if (!job.enabled) continue;

    if (!cron.validate(job.schedule)) {
      console.error(`[cron] Invalid schedule for ${job.name}: ${job.schedule}`);
      continue;
    }

    const task = cron.schedule(job.schedule, () => {
      runJob(job, handleMessage);
    });

    tasks.push(task);
    console.log(`[cron] Scheduled ${job.name}: ${job.schedule}`);
  }
}

async function runJob(job, handleMessage) {
  const startTime = Date.now();
  console.log(`[cron] Running ${job.name}`);

  const runLog = {
    jobId: job.id,
    jobName: job.name,
    startedAt: new Date().toISOString(),
    status: 'running',
  };

  try {
    const result = await handleMessage(job.channel || 'cron', job.prompt, {
      jobId: job.id,
      jobName: job.name,
      model: job.model,
      timeout: job.timeout,
      isolated: job.isolated !== false,
      delivery: job.delivery,
    });

    runLog.status = 'ok';
    runLog.sessionId = result.sessionId || null;
    runLog.response = result.response || '';
  } catch (err) {
    runLog.status = 'error';
    runLog.error = err.message;
    console.error(`[cron] ${job.name} failed:`, err.message);
  }

  runLog.finishedAt = new Date().toISOString();
  runLog.durationMs = Date.now() - startTime;

  const logFile = `${RUNS_DIR}/${job.id}-${Date.now()}.json`;
  mkdirSync(RUNS_DIR, { recursive: true });
  writeFileSync(logFile, JSON.stringify(runLog, null, 2));
}

export function readCronRuns(limit = 50) {
  mkdirSync(RUNS_DIR, { recursive: true });
  const files = readdirSync(RUNS_DIR)
    .filter(f => f.endsWith('.json'))
    .sort()
    .reverse()
    .slice(0, limit);

  return files.map(f => {
    try {
      return JSON.parse(readFileSync(join(RUNS_DIR, f), 'utf8'));
    } catch {
      return null;
    }
  }).filter(Boolean);
}

export function stopScheduler() {
  for (const task of tasks) {
    task.stop();
  }
  tasks.length = 0;
}
