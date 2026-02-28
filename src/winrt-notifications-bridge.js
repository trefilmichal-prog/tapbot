import { spawn } from 'node:child_process';
import { promises as fs, constants as fsConstants } from 'node:fs';
import path from 'node:path';

const HELPER_TIMEOUT_MS = 12000;
const PLATFORM_ENV_MAP = {
  win32: 'WINRT_NOTIFICATIONS_HELPER_PATH_WIN32',
  linux: 'WINRT_NOTIFICATIONS_HELPER_PATH_LINUX',
  darwin: 'WINRT_NOTIFICATIONS_HELPER_PATH_DARWIN'
};

function getHelperPathFromEnvironment() {
  const genericPath = (process.env.WINRT_NOTIFICATIONS_HELPER_PATH ?? '').trim();
  if (genericPath) {
    return genericPath;
  }

  const platformKey = PLATFORM_ENV_MAP[process.platform];
  if (!platformKey) {
    return null;
  }

  const platformPath = (process.env[platformKey] ?? '').trim();
  return platformPath || null;
}

function mapSpawnErrorToCode(error) {
  if (!error) return 'READ_FAILED';
  if (error.code === 'EACCES' || error.code === 'EPERM') return 'ACCESS_DENIED';
  if (error.code === 'ENOENT') return 'API_UNAVAILABLE';
  return 'READ_FAILED';
}

function parseBridgePayload(raw) {
  const parsed = JSON.parse(raw);
  if (!parsed || typeof parsed !== 'object') {
    throw new Error('Bridge returned non-object payload.');
  }

  return {
    ok: Boolean(parsed.ok),
    errorCode: typeof parsed.errorCode === 'string' ? parsed.errorCode : null,
    message: typeof parsed.message === 'string' ? parsed.message : null,
    notifications: Array.isArray(parsed.notifications) ? parsed.notifications : []
  };
}

export async function checkWinRtBridgeAvailability() {
  const helperPath = getHelperPathFromEnvironment();
  if (!helperPath) {
    return {
      available: false,
      helperPath: null,
      reason: 'WINRT notification helper path is not configured.'
    };
  }

  const absolutePath = path.resolve(helperPath);

  try {
    await fs.access(absolutePath, fsConstants.F_OK | fsConstants.X_OK);
  } catch (error) {
    return {
      available: false,
      helperPath: absolutePath,
      reason: `WINRT notification helper is not executable or missing (${error.code ?? 'UNKNOWN'}).`
    };
  }

  return {
    available: true,
    helperPath: absolutePath,
    reason: null
  };
}

export async function readWinRtNotificationsFromBridge() {
  const availability = await checkWinRtBridgeAvailability();
  if (!availability.available) {
    return {
      ok: false,
      errorCode: 'API_UNAVAILABLE',
      message: availability.reason,
      notifications: []
    };
  }

  const helperPath = availability.helperPath;

  return await new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let finished = false;

    const child = spawn(helperPath, ['--mode', 'read-notifications', '--format', 'json'], {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true
    });

    const timeout = setTimeout(() => {
      if (finished) return;
      finished = true;
      child.kill();
      resolve({
        ok: false,
        errorCode: 'READ_FAILED',
        message: `WINRT helper timed out after ${HELPER_TIMEOUT_MS} ms.`,
        notifications: []
      });
    }, HELPER_TIMEOUT_MS);

    child.stdout.on('data', (chunk) => {
      stdout += String(chunk);
    });

    child.stderr.on('data', (chunk) => {
      stderr += String(chunk);
    });

    child.on('error', (error) => {
      if (finished) return;
      finished = true;
      clearTimeout(timeout);
      resolve({
        ok: false,
        errorCode: mapSpawnErrorToCode(error),
        message: `Failed to start WINRT helper: ${error.message}`,
        notifications: []
      });
    });

    child.on('close', (exitCode) => {
      if (finished) return;
      finished = true;
      clearTimeout(timeout);

      const trimmedStdout = stdout.trim();
      if (!trimmedStdout) {
        resolve({
          ok: false,
          errorCode: 'READ_FAILED',
          message: `WINRT helper returned no output (exit code ${exitCode ?? 'unknown'}). ${stderr.trim()}`.trim(),
          notifications: []
        });
        return;
      }

      try {
        const payload = parseBridgePayload(trimmedStdout);
        resolve(payload);
      } catch (error) {
        resolve({
          ok: false,
          errorCode: 'READ_FAILED',
          message: `WINRT helper returned invalid JSON. ${error.message}`,
          notifications: []
        });
      }
    });
  });
}
