/** Standalone workspace CLI; bundled as source so it uses the helper's pinned Node runtime. */
export const clientSource = String.raw`
import { open, mkdir, rename, rm } from 'node:fs/promises';
import { constants } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
const directory = dirname(fileURLToPath(import.meta.url));
const [operation, url, ...extra] = process.argv.slice(2);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const call = join(directory, 'call');
let owned = false;
try {
  if (!['list', 'link', 'unlink'].includes(operation) || extra.length ||
      (operation === 'list' ? url !== undefined : !url || url.length > 8192)) {
    throw new Error('Usage: list | link <GitLab MR URL> | unlink <GitLab MR URL>');
  }
  await mkdir(call, { mode: 0o700 });
  owned = true;
  const id = randomUUID();
  const file = await open(join(call, 'pending.json'), 'wx', 0o600);
  try { await file.writeFile(JSON.stringify({ id, operation, ...(url ? { url } : {}) })); }
  finally { await file.close(); }
  await rename(join(call, 'pending.json'), join(call, 'request.json'));
  const deadline = Date.now() + 15000;
  let result;
  while (Date.now() < deadline) {
    try {
      const response = await open(join(call, 'response.json'), constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const stat = await response.stat();
        if (!stat.isFile() || stat.size > 262144) throw new Error('Invalid MR tool response.');
        const buffer = Buffer.alloc(262145);
        const { bytesRead } = await response.read(buffer, 0, buffer.length, 0);
        if (bytesRead > 262144) throw new Error('Invalid MR tool response.');
        const parsed = JSON.parse(buffer.toString('utf8', 0, bytesRead));
        if (parsed.id !== id) throw new Error('Expired MR tool response.');
        result = parsed;
      } finally { await response.close(); }
      break;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    await sleep(100);
  }
  if (!result) throw new Error('MR tool timed out. The operation may have completed; list links before retrying.');
  if (!result.ok) throw new Error(result.error);
  process.stdout.write(JSON.stringify(result.value) + '\n');
} catch (error) {
  process.stderr.write(error.code === 'EEXIST'
    ? 'Another MR command is running for this turn. Wait for it to finish.\n'
    : error.code ? 'MR tools are unavailable for this turn.\n' : error.message + '\n');
  process.exitCode = 1;
} finally {
  if (owned) await rm(call, { recursive: true, force: true }).catch(() => {});
}
`;
