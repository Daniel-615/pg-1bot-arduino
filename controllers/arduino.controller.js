const { SerialPort } = require('serialport');
const fs = require('fs/promises');
const path = require('path');
const os = require('os');
const { execFile } = require('child_process');
const { promisify } = require('util');

const execAsync = promisify(execFile);
const { ConcurrencyLimiter, KeyedMutex } = require('../services/concurrency.service');
const { ensureArduinoCliInstalled } = require('../services/arduino.cli.service');

const compileLimiter = new ConcurrencyLimiter(
  Number.parseInt(process.env.COMPILE_MAX_CONCURRENCY || '2', 10),
  Number.parseInt(process.env.COMPILE_MAX_QUEUE || '10', 10)
);
const coreInstallMutex = new KeyedMutex();
const uploadMutex = new KeyedMutex();

const DEFAULT_FQBN = 'arduino:avr:uno';

function detectArduinoPort(ports) {

  return ports.find(p => {

    const manufacturer = p.manufacturer?.toLowerCase() || '';
    const vendor = p.vendorId?.toLowerCase() || '';

    return (
      manufacturer.includes('arduino') ||
      manufacturer.includes('wch') ||
      manufacturer.includes('silicon') ||
      vendor === '2341' ||
      vendor === '1a86'
    );

  });

}
async function ensureCoreInstalled(cliPath, fqbn) {

  const core = fqbn.split(':').slice(0, 2).join(':');

  const { stdout } = await execAsync(
    cliPath,
    ['core', 'list', '--format', 'json']
  );

  let parsed = JSON.parse(stdout);

  let cores = [];

  if (Array.isArray(parsed)) {
    cores = parsed;
  } else if (parsed.installed) {
    cores = parsed.installed;
  }

  const exists = cores.some(c =>
    c.ID === core ||
    c.id === core ||
    c.Id === core
  );

  if (!exists) {

    console.log('Installing core:', core);

    await execAsync(cliPath, ['core', 'update-index']);

    await execAsync(cliPath, ['core', 'install', core]);

  }

}
async function compileSketchTemp(fileBuffer, fileName, fqbn, cliPath) {

  const sketchName = path.parse(fileName).name.replace(/[^a-zA-Z0-9]/g, '_');

  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'arduino-'));

  const sketchDir = path.join(tempDir, sketchName);

  await fs.mkdir(sketchDir);

  const sketchPath = path.join(sketchDir, `${sketchName}.ino`);

  await fs.writeFile(sketchPath, fileBuffer);

  const buildDir = path.join(tempDir, 'build');

  await fs.mkdir(buildDir);

  console.log('\n===== COMPILING =====');

  const { stdout, stderr } = await execAsync(
    cliPath,
    ['compile', '-b', fqbn, '--output-dir', buildDir, sketchDir]
  );

  console.log(stdout);

  return { buildDir, tempDir, log: stdout + stderr };

}

async function uploadSketch(buildDir, port, fqbn, cliPath) {

  console.log('\n===== UPLOADING =====');

  const { stdout, stderr } = await execAsync(
    cliPath,
    [
      'upload',
      '-p',
      port,
      '--fqbn',
      fqbn,
      '--input-dir',
      buildDir
    ]
  );

  console.log(stdout);

  return stdout + stderr;

}

const compileAndUpload = async (req, res) => {

  let tempDir = null;

  try {

    if (!req.file) {
      return res.status(400).json({
        ok: false,
        message: 'No file uploaded'
      });
    }

    const fqbn = req.body.fqbn || DEFAULT_FQBN;
    const upload = req.body.upload === 'true' || req.body.upload === true;

    console.log('\n========== NEW REQUEST ==========');
    console.log('File:', req.file.originalname);
    console.log('FQBN:', fqbn);
    console.log('Upload:', upload);

    const core = fqbn.split(':').slice(0, 2).join(':');
    const cli = await ensureArduinoCliInstalled();
    await coreInstallMutex.run(core, () => ensureCoreInstalled(cli.cliPath, fqbn));

    const ports = await SerialPort.list();

    const detected = detectArduinoPort(ports);

    const port = req.body.port || detected?.path;

    if (!port && upload) {
      throw new Error('No Arduino port detected');
    }

    console.log('Port:', port);

    const compileResult = await compileSketchTemp(
      req.file.buffer,
      req.file.originalname,
      fqbn,
      cli.cliPath
    );

    tempDir = compileResult.tempDir;

    let uploadResult = null;

    if (upload) {

      uploadResult = await uploadMutex.run(port, () => uploadSketch(
        compileResult.buildDir,
        port,
        fqbn,
        cli.cliPath
      ));

    }

    await fs.rm(tempDir, { recursive: true, force: true });

    return res.json({

      ok: true,
      message: upload
        ? 'Compiled and uploaded successfully'
        : 'Compiled successfully',

      compileLog: compileResult.log,
      uploadLog: uploadResult,
      port

    });

  } catch (error) {

    console.error(error);

    if (tempDir) {
      await fs.rm(tempDir, { recursive: true, force: true });
    }

    return res.status(500).json({

      ok: false,
      error: error.message

    });

  }

};

const compileAndUploadQueued = async (req, res) => {
  try {
    return await compileLimiter.run(() => compileAndUpload(req, res));
  } catch (error) {
    return res.status(error.statusCode || 503).json({ ok: false, error: error.message });
  }
};

const listPorts = async (req, res) => {

  try {

    const ports = await SerialPort.list();

    return res.json({
      ok: true,
      ports
    });

  } catch (error) {

    return res.status(500).json({
      ok: false,
      error: error.message
    });

  }

};

module.exports = {
  compileAndUpload: compileAndUploadQueued,
  listPorts
};
