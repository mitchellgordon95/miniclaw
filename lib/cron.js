import cron from 'node-cron';
import { spawn } from 'child_process';
import { readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { getHomePath, loadConfig } from './config.js';
import { sendSMS } from './channels.js';

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
 * Jobs run via the Claude CLI as separate processes.
 */
export function startScheduler() {
  const jobs = loadJobs();

  for (const job of jobs) {
    if (!job.enabled) continue;

    if (!cron.validate(job.schedule)) {
      console.error(`[cron] Invalid schedule for ${job.name}: ${job.schedule}`);
      continue;
    }

    const task = cron.schedule(job.schedule, () => {
      runJob(job);
    });

    tasks.push(task);
    console.log(`[cron] Scheduled ${job.name}: ${job.schedule}`);
  }
}

async function runJob(job) {
  const startTime = Date.now();
  const config = loadConfig();
  console.log(`[cron] Running ${job.name}`);

  const runLog = {
    jobId: job.id,
    jobName: job.name,
    startedAt: new Date().toISOString(),
    status: 'running',
  };

  try {
    const response = await runCLI(job, config);
    runLog.status = 'ok';
    runLog.response = response;

    // Handle delivery
    await handleDelivery(job, response, config);
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

/**
 * Run a Claude CLI process for a cron job.
 */
function runCLI(job, config) {
  return new Promise((resolve, reject) => {
    const args = [
      '-p',
      '--model', job.model || 'sonnet',
      '--dangerously-skip-permissions',
      '--output-format', 'text',
      '--no-session-persistence',
      '--add-dir', config.workspacePath,
      '--append-system-prompt', buildSystemPrompt(job),
      job.prompt,
    ];

    const proc = spawn('claude', args, {
      cwd: config.workspacePath,
      env: { ...process.env },
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: job.timeout || 300000,
    });

    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
    proc.stderr.on('data', (chunk) => { stderr += chunk.toString(); });

    const timer = setTimeout(() => {
      proc.kill('SIGTERM');
      reject(new Error(`Timeout after ${job.timeout || 300000}ms`));
    }, job.timeout || 300000);

    proc.on('close', (code) => {
      clearTimeout(timer);
      if (stderr) {
        console.error(`[cron] ${job.name} stderr: ${stderr.slice(0, 500)}`);
      }
      if (code !== 0) {
        reject(new Error(`CLI exited with code ${code}: ${stderr.slice(0, 300) || stdout.slice(0, 300)}`));
      } else {
        console.log(`[cron] ${job.name} completed (${stdout.length} chars)`);
        resolve(stdout.trim());
      }
    });

    proc.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

function buildSystemPrompt(job) {
  const now = new Date();
  const timeStr = `Current time: ${now.toISOString()} (${now.toLocaleString('en-US', { timeZone: 'America/New_York', dateStyle: 'full', timeStyle: 'short' })} ET)`;
  const parts = [
    timeStr,
    `Channel: ${job.channel || 'cron'}`,
    `Job: ${job.name}`,
    'You are running as a cron job inside MiniClaw, a personal assistant gateway.',
  ];
  return parts.join('\n');
}

async function handleDelivery(job, response, config) {
  const delivery = job.delivery || 'none';
  if (delivery === 'none') return;

  const to = config.twilio.allowFrom[0];
  const skip = ['HEARTBEAT_OK', 'NOTHING_TO_REPORT'];

  if (delivery === 'sms') {
    await sendSMS(to, response);
  } else if (delivery === 'sms-if-needed') {
    if (!skip.some(s => response.trim().startsWith(s))) {
      await sendSMS(to, response);
    }
  }
}

export function readCronRuns(limit = 50) {
  mkdirSync(RUNS_DIR, { recursive: true });
  const files = readdirSync(RUNS_DIR).filter(f => f.endsWith('.json'));

  const runs = files.map(f => {
    try {
      return JSON.parse(readFileSync(join(RUNS_DIR, f), 'utf8'));
    } catch {
      return null;
    }
  }).filter(Boolean);

  runs.sort((a, b) => (b.startedAt || '').localeCompare(a.startedAt || ''));
  return runs.slice(0, limit);
}

export function stopScheduler() {
  for (const task of tasks) {
    task.stop();
  }
  tasks.length = 0;
}
