import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { pipeline } from 'node:stream/promises';

const execFileAsync = promisify(execFile);
const DEFAULT_ZIP_URL = 'https://github.com/trefilmichal-prog/tapbot/archive/refs/heads/main.zip';
const KEEP_ENTRIES = new Set(['config.json', 'data', 'node_modules', 'package-lock.json']);

async function downloadZip(url, destinationPath) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Download failed with status ${response.status}`);
  }
  if (!response.body) {
    throw new Error('Download failed: empty response body.');
  }

  await fsPromises.mkdir(path.dirname(destinationPath), { recursive: true });
  await pipeline(response.body, fs.createWriteStream(destinationPath));
}

async function extractZip(zipPath, destinationDir) {
  await fsPromises.mkdir(destinationDir, { recursive: true });
  try {
    if (process.platform === 'win32') {
      const escapePwsh = (value) => value.replace(/'/g, "''");
      const command = [
        'Expand-Archive',
        '-LiteralPath',
        `'${escapePwsh(zipPath)}'`,
        '-DestinationPath',
        `'${escapePwsh(destinationDir)}'`,
        '-Force'
      ].join(' ');
      await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command]);
    } else {
      await execFileAsync('unzip', ['-q', zipPath, '-d', destinationDir]);
    }
  } catch (error) {
    const platformHint = process.platform === 'win32'
      ? 'Ensure PowerShell Expand-Archive is available.'
      : 'Ensure unzip is installed and available in PATH.';
    throw new Error(`ZIP extraction failed on ${process.platform}: ${error.message ?? error}. ${platformHint}`);
  }
}

async function findExtractedRoot(extractDir) {
  const entries = await fsPromises.readdir(extractDir, { withFileTypes: true });
  const rootEntry = entries.find((entry) => entry.isDirectory());
  if (!rootEntry) {
    throw new Error('No extracted directory found in ZIP.');
  }
  return path.join(extractDir, rootEntry.name);
}

async function replaceWorkingTree(sourceRoot, targetRoot) {
  const currentEntries = await fsPromises.readdir(targetRoot, { withFileTypes: true });
  await Promise.all(currentEntries.map(async (entry) => {
    if (KEEP_ENTRIES.has(entry.name)) return;
    await fsPromises.rm(path.join(targetRoot, entry.name), { recursive: true, force: true });
  }));

  const incomingEntries = await fsPromises.readdir(sourceRoot, { withFileTypes: true });
  await Promise.all(incomingEntries.map(async (entry) => {
    if (KEEP_ENTRIES.has(entry.name)) return;
    await fsPromises.cp(
      path.join(sourceRoot, entry.name),
      path.join(targetRoot, entry.name),
      { recursive: true, force: true }
    );
  }));
}

async function resolvePm2ProcessName(repoRoot) {
  const runBatPath = path.join(repoRoot, 'run.bat');
  try {
    const content = await fsPromises.readFile(runBatPath, 'utf8');
    const match = content.match(/--name\s+(\S+)/i);
    if (match) {
      return match[1].trim();
    }
  } catch (error) {
    // Ignore missing run.bat or parse errors
  }
  return 'tapbot';
}

async function restartPm2(processName) {
  let stopError;
  let startError;

  try {
    await execFileAsync('pm2', ['stop', processName]);
    console.log(`PM2 stop completed for ${processName}.`);
  } catch (error) {
    stopError = error;
    console.error(`PM2 stop failed for ${processName}:`, error);
  }

  try {
    await execFileAsync('pm2', ['start', processName]);
    console.log(`PM2 start completed for ${processName}.`);
  } catch (error) {
    startError = error;
    console.error(`PM2 start failed for ${processName}:`, error);
  }

  if (stopError || startError) {
    try {
      console.warn(`Attempting PM2 restart fallback for ${processName}.`);
      await execFileAsync('pm2', ['restart', processName]);
      console.log(`PM2 restart fallback completed for ${processName}.`);
      return;
    } catch (error) {
      const stopMessage = stopError?.message ?? stopError;
      const startMessage = startError?.message ?? startError;
      throw new Error(
        `PM2 stop/start failed (stop: ${stopMessage || 'ok'}, start: ${startMessage || 'ok'}) and restart fallback failed: ${error.message ?? error}`
      );
    }
  }
}

async function findBatchRestartScript(repoRoot) {
  const candidates = ['restart.bat', 'run.bat'];
  for (const candidate of candidates) {
    const scriptPath = path.join(repoRoot, candidate);
    try {
      await fsPromises.access(scriptPath, fs.constants.F_OK);
      return scriptPath;
    } catch (error) {
      // Continue searching.
    }
  }
  return null;
}

async function runBatchRestart(repoRoot) {
  if (process.platform !== 'win32') {
    return {
      ok: false,
      error: new Error('Batch restart is only supported on Windows (win32).'),
      stdout: '',
      stderr: ''
    };
  }

  const scriptPath = await findBatchRestartScript(repoRoot);
  if (!scriptPath) {
    return {
      ok: false,
      error: new Error('Failed to find a restart .bat script.'),
      stdout: '',
      stderr: ''
    };
  }

  try {
    const result = await execFileAsync('cmd.exe', ['/c', scriptPath], { cwd: repoRoot });
    return {
      ok: true,
      stdout: result.stdout,
      stderr: result.stderr,
      scriptPath
    };
  } catch (error) {
    return {
      ok: false,
      stdout: error.stdout ?? '',
      stderr: error.stderr ?? '',
      error,
      scriptPath
    };
  }
}

async function runDeployCommands(repoRoot) {
  try {
    const result = await execFileAsync(
      process.execPath,
      ['src/deploy-commands.js'],
      { cwd: repoRoot }
    );
    return {
      ok: true,
      stdout: result.stdout,
      stderr: result.stderr
    };
  } catch (error) {
    return {
      ok: false,
      stdout: error.stdout,
      stderr: error.stderr,
      error
    };
  }
}

export async function runUpdate({
  zipUrl = DEFAULT_ZIP_URL,
  deployCommands = false,
  batchRestart = false
} = {}) {
  const repoRoot = path.resolve(process.cwd());
  const tempDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'tapbot-update-'));
  const zipPath = path.join(tempDir, 'update.zip');
  const extractDir = path.join(tempDir, 'extract');

  await downloadZip(zipUrl, zipPath);
  await extractZip(zipPath, extractDir);
  const sourceRoot = await findExtractedRoot(extractDir);
  await replaceWorkingTree(sourceRoot, repoRoot);
  let deployResult = null;
  if (deployCommands) {
    deployResult = await runDeployCommands(repoRoot);
    if (deployResult.ok) {
      if (deployResult.stdout) {
        console.log('Deploy commands stdout:', deployResult.stdout.trim());
      }
      if (deployResult.stderr) {
        console.warn('Deploy commands stderr:', deployResult.stderr.trim());
      }
    } else {
      console.error('Deploy commands failed during update:', deployResult.error);
      if (deployResult.stdout) {
        console.error('Deploy commands stdout:', deployResult.stdout.trim());
      }
      if (deployResult.stderr) {
        console.error('Deploy commands stderr:', deployResult.stderr.trim());
      }
    }
  }
  let restartResult = null;
  if (batchRestart) {
    restartResult = await runBatchRestart(repoRoot);
    if (!restartResult.ok) {
      console.error('Batch restart failed during update:', restartResult.error);
      if (restartResult.stdout) {
        console.error('Batch restart stdout:', restartResult.stdout.trim());
      }
      if (restartResult.stderr) {
        console.error('Batch restart stderr:', restartResult.stderr.trim());
      }

      const processName = await resolvePm2ProcessName(repoRoot);
      try {
        await restartPm2(processName);
        restartResult = { ...restartResult, fallback: 'pm2' };
      } catch (error) {
        throw new Error(
          `Batch restart failed${restartResult.scriptPath ? ` (${path.basename(restartResult.scriptPath)})` : ''} and fallback pm2 restart also failed: ${error.message ?? error}`
        );
      }
    }
  } else {
    const processName = await resolvePm2ProcessName(repoRoot);
    await restartPm2(processName);
  }

  return { deployResult, restartResult };
}
