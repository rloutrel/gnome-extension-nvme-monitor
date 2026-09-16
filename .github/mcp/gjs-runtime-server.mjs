import {execFile} from 'node:child_process';
import {promises as fs} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const workspace = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const runtimeMode = process.env.GJS_RUNTIME_MODE === 'docker' ? 'docker' : 'host';
const dockerImage = process.env.GJS_DOCKER_IMAGE || 'ghcr.io/gnome/gjs:latest';

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function result(id, content, isError = false) {
  send({jsonrpc: '2.0', id, result: {content: [{type: 'text', text: content}], isError}});
}

function initializeResult(id) {
  send({jsonrpc: '2.0', id, result: {protocolVersion: '2024-11-05', capabilities: {tools: {}},
    serverInfo: {name: 'gjs-runtime', version: '1.0.0'}}});
}

function run(command, args, cwd = workspace) {
  return new Promise((resolve) => {
    execFile(command, args, {cwd, maxBuffer: 1024 * 1024}, (error, stdout, stderr) => {
      resolve({error, stdout, stderr});
    });
  });
}

async function checkSyntax(filePath) {
  const absolutePath = path.resolve(workspace, filePath);
  if (!absolutePath.startsWith(`${workspace}${path.sep}`))
    throw new Error('filePath must stay inside the workspace');
  await fs.access(absolutePath);

  if (runtimeMode === 'docker') {
    const relativePath = path.relative(workspace, absolutePath);
    return run('docker', ['run', '--rm', '-i', '-v', `${workspace}:/workspace:ro`, dockerImage,
      'gjs', '--check', `/workspace/${relativePath}`]);
  }

  return run('gjs', ['--check', absolutePath]);
}

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  input += chunk;
  const lines = input.split('\n');
  input = lines.pop();
  for (const line of lines) {
    if (!line.trim())
      continue;
    void handle(JSON.parse(line));
  }
});

async function handle(request) {
  if (request.method === 'initialize') {
    initializeResult(request.id);
    return;
  }
  if (request.method === 'notifications/initialized')
    return;
  if (request.method === 'tools/list') {
    send({jsonrpc: '2.0', id: request.id, result: {tools: [{
      name: 'check_syntax',
      description: 'Run gjs --check on a workspace file using host GJS or a configured Docker image.',
      inputSchema: {type: 'object', properties: {filePath: {type: 'string'}}, required: ['filePath']}
    }]}});
    return;
  }
  if (request.method === 'tools/call' && request.params?.name === 'check_syntax') {
    try {
      const execution = await checkSyntax(request.params.arguments?.filePath);
      const output = [execution.stdout, execution.stderr].filter(Boolean).join('\n') || 'Syntax check passed.';
      result(request.id, output, Boolean(execution.error));
    } catch (error) {
      result(request.id, error.message, true);
    }
    return;
  }
  if (request.id !== undefined)
    send({jsonrpc: '2.0', id: request.id, error: {code: -32601, message: 'Method not found'}});
}
