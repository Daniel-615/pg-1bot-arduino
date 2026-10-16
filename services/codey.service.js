const { promisify } = require('util');
const { execFile } = require('child_process');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');

const execFileAsync = promisify(execFile);
const { ConcurrencyLimiter, KeyedMutex } = require('./concurrency.service');
const compileLimiter = new ConcurrencyLimiter(
  Number.parseInt(process.env.COMPILE_MAX_CONCURRENCY || '2', 10),
  Number.parseInt(process.env.COMPILE_MAX_QUEUE || '20', 10)
);
const uploadMutex = new KeyedMutex();

function commandFromEnv(name, fallback) {
  return (process.env[name] || fallback).trim();
}

async function runPythonSyntaxCheck(filePath) {
  const python = commandFromEnv('CODEY_PYTHON_PATH', process.platform === 'win32' ? 'python' : 'python3');
  await execFileAsync(python, ['-m', 'py_compile', filePath], { windowsHide: true });
}

async function uploadToCodey(filePath, port) {
  if (!port) {
    throw new Error('Selecciona un puerto para cargar el programa en Codey.');
  }

  const mpremote = commandFromEnv('CODEY_MPREMOTE_PATH', 'mpremote');
  const { stdout, stderr } = await execFileAsync(
    mpremote,
    ['connect', port, 'fs', 'cp', filePath, ':main.py'],
    { windowsHide: true, maxBuffer: 10 * 1024 * 1024 }
  );

  return [stdout, stderr].filter(Boolean).join('\n').trim();
}

async function compileAndUploadCodey({ fileName, fileBuffer, upload, port }) {
  if (!fileBuffer || !fileBuffer.length) {
    throw new Error('No se recibió ningún archivo para compilar.');
  }

  const extension = path.extname(fileName || '').toLowerCase();
  if (extension !== '.py') {
    throw new Error('Codey requiere un archivo .py.');
  }

  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'codey-compile-'));
  const filePath = path.join(tempRoot, 'main.py');

  try {
    await fs.writeFile(filePath, fileBuffer);
    await runPythonSyntaxCheck(filePath);

    const uploadLog = upload ? await uploadMutex.run(port, () => uploadToCodey(filePath, port)) : null;
    return {
      fileName: 'main.py',
      compileLog: 'Sintaxis MicroPython válida.',
      uploadLog,
      port: port || null,
    };
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
}

function compileAndUploadCodeyQueued(options) {
  return compileLimiter.run(() => compileAndUploadCodey(options));
}

module.exports = { compileAndUploadCodey: compileAndUploadCodeyQueued };
