import cron from 'node-cron';
import { spawn } from 'child_process';
import { readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { getHomePath, loadConfig } from './config.js';
import { sendSMS } from './channels.js';

const JOBS_PATH = join(loadConfig().workspacePath, 'cron/jobs.json');
const RUNS_DIR = getHomePath('cron/runs');

const tasks = [];

// All jobs run through a single FIFO chain so two crons can never execute
// concurrently (e.g. finance-snapshot overlapping weekly-report). A job that
// fires while another is running just waits its turn.
let jobChain = Promise.resolve();

function enqueueJob(job) {
  jobChain = jobChain.then(() => runJob(job)).catch(() => {});
}

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
      enqueueJob(job);
    });

    tasks.push(task);
    console.log(`[cron] Scheduled ${job.name}: ${job.schedule}`);
  }
}

async function runJob(job) {
  const startTime = Date.now();
  const config = loadConfig();

  // Hot-reload: re-read jobs.json to pick up prompt/config changes without restart
  const freshJobs = loadJobs();
  const freshJob = freshJobs.find(j => j.id === job.id);
  if (freshJob) {
    Object.assign(job, freshJob);
  }

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
    await notifyFailure(job, err, config);
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

    const fail = (message) => {
      const err = new Error(message);
      err.stdout = stdout;
      err.stderr = stderr;
      reject(err);
    };

    const timer = setTimeout(() => {
      proc.kill('SIGTERM');
      fail(`Timeout after ${job.timeout || 300000}ms`);
    }, job.timeout || 300000);

    proc.on('close', (code) => {
      clearTimeout(timer);
      if (stderr) {
        console.error(`[cron] ${job.name} stderr: ${stderr.slice(0, 500)}`);
      }
      if (code !== 0) {
        fail(`CLI exited with code ${code}: ${stderr.slice(0, 300) || stdout.slice(0, 300)}`);
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

/**
 * Email Mitchell when a cron job fails or times out, with output tails,
 * so failures are never silent. Uses the workspace send-email script.
 */
function notifyFailure(job, err, config) {
  return new Promise((resolve) => {
    const esc = (s) => String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const tail = (s) => esc(String(s).slice(-2000));
    const section = (title, body) => body
      ? `<h3>${title}</h3><pre style="background:#f5f5f5;padding:8px;white-space:pre-wrap;">${tail(body)}</pre>`
      : '';
    const html = `<html><body style="font-family: sans-serif; max-width: 700px;">
<h2>Cron job failed: ${esc(job.name)}</h2>
<p><b>Error:</b> ${esc(err.message)}</p>
<p><b>Schedule:</b> <code>${esc(job.schedule)}</code> &nbsp; <b>Timeout:</b> ${job.timeout || 300000}ms</p>
${section('stdout (tail)', err.stdout)}
${section('stderr (tail)', err.stderr)}
<p>Full run logs live in <code>~/.miniclaw/cron/runs/</code> and <code>journalctl -u miniclaw</code>.
Reply here or tell Wright to investigate.</p>
</body></html>`;

    const proc = spawn('python3', [
      'scripts/send-email.py',
      config.ownerEmail || 'actualcookie003@gmail.com',
      `MiniClaw cron failed: ${job.name}`,
    ], {
      cwd: config.workspacePath,
      env: { ...process.env },
      stdio: ['pipe', 'ignore', 'ignore'],
    });

    // Notification is best-effort: never let it throw or hang the queue.
    const timer = setTimeout(() => { proc.kill('SIGTERM'); resolve(); }, 30000);
    proc.on('error', () => { clearTimeout(timer); resolve(); });
    proc.on('close', () => { clearTimeout(timer); resolve(); });
    proc.stdin.on('error', () => {});
    proc.stdin.write(html);
    proc.stdin.end();
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
