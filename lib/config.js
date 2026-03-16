import { readFileSync, mkdirSync, existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

const MINICLAW_HOME = join(homedir(), '.miniclaw');

let _config = null;

export function getHomePath(rel) {
  return join(MINICLAW_HOME, rel);
}

export function loadConfig() {
  if (_config) return _config;

  const configPath = getHomePath('miniclaw.json');
  if (!existsSync(configPath)) {
    throw new Error(`Config not found: ${configPath}\nCreate ~/.miniclaw/miniclaw.json first.`);
  }

  _config = JSON.parse(readFileSync(configPath, 'utf8'));

  // Defaults
  _config.port = _config.port || 3333;
  _config.model = _config.model || 'opus';
  _config.workspacePath = _config.workspacePath || getHomePath('workspace');

  // Validate required fields
  if (!_config.auth?.token) throw new Error('Config missing auth.token');
  if (!_config.twilio?.accountSid) throw new Error('Config missing twilio.accountSid');
  if (!_config.twilio?.authToken) throw new Error('Config missing twilio.authToken');
  if (!_config.twilio?.phoneNumber) throw new Error('Config missing twilio.phoneNumber');

  return _config;
}

export function ensureRuntimeDirs() {
  const dirs = [
    MINICLAW_HOME,
    getHomePath('cron/runs'),
    getHomePath('logs'),
  ];

  for (const dir of dirs) {
    mkdirSync(dir, { recursive: true });
  }

  const wsPath = loadConfig().workspacePath;
  if (!existsSync(wsPath)) {
    throw new Error(`Workspace not found: ${wsPath}\nCopy from ~/.openclaw/workspace first.`);
  }
}
