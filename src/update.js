import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { pipeline } from 'node:stream/promises';

const execFileAsync = promisify(execFile);
const DEFAULT_ZIP_URL = 'https://github.com/trefilmichal-prog/tapbot/archive/refs/heads/main.zip';
const KEEP_ENTRIES = new Set(['config.json', 'data']);

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
  try {
    await execFileAsync('pm2', ['restart', processName]);
  } catch (error) {
    throw new Error(`PM2 restart failed: ${error.message ?? error}`);
  }
}

export async function runUpdate({ zipUrl = DEFAULT_ZIP_URL } = {}) {
  const repoRoot = path.resolve(process.cwd());
  const tempDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'tapbot-update-'));
  const zipPath = path.join(tempDir, 'update.zip');
  const extractDir = path.join(tempDir, 'extract');

  await downloadZip(zipUrl, zipPath);
  await extractZip(zipPath, extractDir);
  const sourceRoot = await findExtractedRoot(extractDir);
  await replaceWorkingTree(sourceRoot, repoRoot);
  const processName = await resolvePm2ProcessName(repoRoot);
  await restartPm2(processName);
}
