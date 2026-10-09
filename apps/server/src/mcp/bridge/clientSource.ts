/**
 * Coder: the standalone workspace CLI for T3 tools, bundled as source so it runs on the helper's
 * pinned Node runtime. Usage: `--list`, `--schema <tool>`, or `<tool> [json | -]`.
 */
export const clientSource = String.raw`
import { open, mkdir, readFile, rename, rm } from 'node:fs/promises';
import { constants } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
const directory = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const MAX_REQUEST = 262144;
const MAX_RESPONSE = 262144;
const usage = 'Usage: --list | --schema <tool> | <tool> [json params | - to read them from stdin]';
let call;
try {
  if (args[0] === '--list' || args[0] === '--schema') {
    const catalog = JSON.parse(await readFile(join(directory, 'tools.json'), 'utf8'));
    if (args[0] === '--list') {
      if (args.length !== 1) throw new Error(usage);
      for (const tool of catalog) {
        process.stdout.write(tool.name + (tool.readOnly ? ' (read-only)' : '') + ': ' + tool.description + '\n');
      }
    } else {
      const tool = args.length === 2 ? catalog.find((entry) => entry.name === args[1]) : undefined;
      if (!tool) throw new Error('Unknown T3 tool. Run --list to see the available tools.');
      process.stdout.write(JSON.stringify(tool.inputSchema, null, 2) + '\n');
    }
  } else {
    const [tool, raw, ...extra] = args;
    if (!tool || extra.length) throw new Error(usage);
    let text = raw ?? '{}';
    if (text === '-') {
      const chunks = [];
      let size = 0;
      for await (const chunk of process.stdin) {
        size += chunk.length;
        if (size > MAX_REQUEST) throw new Error('T3 tool parameters exceed 256 KiB.');
        chunks.push(chunk);
      }
      text = Buffer.concat(chunks).toString('utf8');
    }
    let params;
    try { params = JSON.parse(text); } catch { throw new Error('T3 tool parameters must be a JSON object.'); }
    if (!params || typeof params !== 'object' || Array.isArray(params)) {
      throw new Error('T3 tool parameters must be a JSON object.');
    }
    const id = randomUUID();
    const request = JSON.stringify({ id, tool, params });
    if (Buffer.byteLength(request) > MAX_REQUEST) throw new Error('T3 tool parameters exceed 256 KiB.');
    call = join(directory, 'calls', id);
    await mkdir(call, { mode: 0o700 });
    const file = await open(join(call, 'pending.json'), 'wx', 0o600);
    try { await file.writeFile(request); } finally { await file.close(); }
    await rename(join(call, 'pending.json'), join(call, 'request.json'));
    const deadline = Date.now() + 15000;
    let result;
    while (Date.now() < deadline) {
      try {
        const response = await open(join(call, 'response.json'), constants.O_RDONLY | constants.O_NOFOLLOW);
        try {
          const stat = await response.stat();
          if (!stat.isFile() || stat.size > MAX_RESPONSE) throw new Error('Invalid T3 tool response.');
          const buffer = Buffer.alloc(MAX_RESPONSE + 1);
          const { bytesRead } = await response.read(buffer, 0, buffer.length, 0);
          if (bytesRead > MAX_RESPONSE) throw new Error('Invalid T3 tool response.');
          const parsed = JSON.parse(buffer.toString('utf8', 0, bytesRead));
          if (parsed.id !== id) throw new Error('Expired T3 tool response.');
          result = parsed;
        } finally { await response.close(); }
        break;
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
      await sleep(50);
    }
    if (!result) {
      throw new Error('T3 tool call timed out. It may have completed; check its result before retrying.');
    }
    if (result.ok) {
      process.stdout.write(JSON.stringify(result.value) + '\n');
    } else if (result.value !== undefined) {
      process.stdout.write(JSON.stringify(result.value) + '\n');
      process.exitCode = 1;
    } else {
      throw new Error(result.error);
    }
  }
} catch (error) {
  process.stderr.write(error.code ? 'T3 tools are unavailable for this thread.\n' : error.message + '\n');
  process.exitCode = 1;
} finally {
  if (call) await rm(call, { recursive: true, force: true }).catch(() => {});
}
`;
