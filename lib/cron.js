import cron from 'node-cron';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
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
    await handleMessage(job.channel || 'cron', job.prompt, {
      jobId: job.id,
      jobName: job.name,
      model: job.model,
      timeout: job.timeout,
      isolated: job.isolated !== false, // Default to isolated
      delivery: job.delivery,
    });

    runLog.status = 'ok';
  } catch (err) {
    runLog.status = 'error';
    runLog.error = err.message;
    console.error(`[cron] ${job.name} failed:`, err.message);
  }

  runLog.finishedAt = new Date().toISOString();
  runLog.durationMs = Date.now() - startTime;

  // Write run log
  const logFile = `${RUNS_DIR}/${job.id}-${Date.now()}.json`;
  mkdirSync(RUNS_DIR, { recursive: true });
  writeFileSync(logFile, JSON.stringify(runLog, null, 2));
}

export function stopScheduler() {
  for (const task of tasks) {
    task.stop();
  }
  tasks.length = 0;
}
