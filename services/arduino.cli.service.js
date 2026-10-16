const { promisify } = require('util');
const { execFile } = require('child_process');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const http = require('http');
const https = require('https');

const execFileAsync = promisify(execFile);
const MAX_BUFFER_SIZE = 10 * 1024 * 1024;
const ARTIFACT_PRIORITY = ['.hex', '.bin', '.uf2', '.elf'];
const DEFAULT_RELEASE_VERSION = 'latest';
const GITHUB_RELEASES_API = 'https://api.github.com/repos/arduino/arduino-cli/releases';
const LOCAL_INSTALL_ROOT = path.resolve(__dirname, '..', 'arduino-data', 'tools', 'arduino-cli');

let installPromise = null;

const getCliExecutableName = () => (process.platform === 'win32' ? 'arduino-cli.exe' : 'arduino-cli');

const getLocalInstallDir = () => path.join(LOCAL_INSTALL_ROOT, `${process.platform}-${process.arch}`);

const getLocalCliPath = () => path.join(getLocalInstallDir(), getCliExecutableName());

const normalizeConfiguredCliPath = (configuredPath) => {
  if (!configuredPath) {
    return null;
  }

  const normalizedPath = configuredPath.trim().replace(/^["']|["']$/g, '');
  const parsedPath = path.parse(normalizedPath);

  if (parsedPath.ext || path.basename(normalizedPath).toLowerCase().startsWith('arduino-cli')) {
    return normalizedPath;
  }

  return path.join(normalizedPath, getCliExecutableName());
};

const pathExists = async (targetPath) => {
  try {
    await fs.access(targetPath);
    return true;
  } catch (error) {
    return false;
  }
};

const resolveInstalledCliPath = async () => {
  const configuredPath = normalizeConfiguredCliPath(process.env.ARDUINO_CLI_PATH);

  if (configuredPath && (await pathExists(configuredPath))) {
    return {
      cliPath: configuredPath,
      source: 'configured',
    };
  }

  const localCliPath = getLocalCliPath();
  if (await pathExists(localCliPath)) {
    return {
      cliPath: localCliPath,
      source: 'managed',
    };
  }

  return {
    cliPath: 'arduino-cli',
    source: 'path',
  };
};

const sanitizeSketchName = (filename = 'sketch.ino') => {
  const parsedName = path.parse(filename);
  const baseName = parsedName.name || 'sketch';
  const normalized = baseName.replace(/[^a-zA-Z0-9_-]/g, '_');

  return normalized || 'sketch';
};

const listFilesRecursively = async (dirPath) => {
  const dirEntries = await fs.readdir(dirPath, { withFileTypes: true });
  const nested = await Promise.all(
    dirEntries.map(async (entry) => {
      const fullPath = path.join(dirPath, entry.name);

      if (entry.isDirectory()) {
        return listFilesRecursively(fullPath);
      }

      return [fullPath];
    })
  );

  return nested.flat();
};

const pickCompiledArtifact = async (outputDir, sketchName) => {
  const files = await listFilesRecursively(outputDir);
  const preferredBaseName = sketchName.toLowerCase();

  for (const extension of ARTIFACT_PRIORITY) {
    const preferredMatch = files.find((filePath) => {
      const parsed = path.parse(filePath);
      return parsed.ext.toLowerCase() === extension && parsed.name.toLowerCase() === preferredBaseName;
    });

    if (preferredMatch) {
      return preferredMatch;
    }
  }

  for (const extension of ARTIFACT_PRIORITY) {
    const fallbackMatch = files.find((filePath) => path.extname(filePath).toLowerCase() === extension);

    if (fallbackMatch) {
      return fallbackMatch;
    }
  }

  return null;
};

const getReleaseLookupTarget = () => {
  if (process.platform === 'win32') {
    if (process.arch === 'x64') {
      return {
        archiveType: 'zip',
        assetPattern: /Windows_64bit\.zip$/i,
      };
    }

    if (process.arch === 'arm64') {
      return {
        archiveType: 'zip',
        assetPattern: /Windows_ARM64\.zip$/i,
      };
    }
  }

  if (process.platform === 'darwin') {
    if (process.arch === 'x64') {
      return {
        archiveType: 'tar.gz',
        assetPattern: /macOS_64bit\.tar\.gz$/i,
      };
    }

    if (process.arch === 'arm64') {
      return {
        archiveType: 'tar.gz',
        assetPattern: /macOS_ARM64\.tar\.gz$/i,
      };
    }
  }

  if (process.platform === 'linux') {
    if (process.arch === 'x64') {
      return {
        archiveType: 'tar.gz',
        assetPattern: /Linux_64bit\.tar\.gz$/i,
      };
    }

    if (process.arch === 'arm64') {
      return {
        archiveType: 'tar.gz',
        assetPattern: /Linux_ARM64\.tar\.gz$/i,
      };
    }
  }

  throw new Error(
    `No hay un asset oficial configurado para platform=${process.platform} arch=${process.arch}.`
  );
};

const requestJson = (url) =>
  new Promise((resolve, reject) => {
    https
      .get(
        url,
        {
          headers: {
            'User-Agent': 'pg-1bot-backend',
            Accept: 'application/vnd.github+json',
          },
        },
        (response) => {
          if (response.statusCode && response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
            response.resume();
            resolve(requestJson(response.headers.location));
            return;
          }

          if (response.statusCode !== 200) {
            response.resume();
            reject(new Error(`No se pudo consultar GitHub Releases. HTTP ${response.statusCode}.`));
            return;
          }

          let rawData = '';
          response.setEncoding('utf8');
          response.on('data', (chunk) => {
            rawData += chunk;
          });
          response.on('end', () => {
            try {
              resolve(JSON.parse(rawData));
            } catch (error) {
              reject(new Error(`Respuesta invalida de GitHub Releases: ${error.message}`));
            }
          });
        }
      )
      .on('error', (error) => {
        reject(new Error(`No se pudo conectar a GitHub Releases: ${error.message}`));
      });
  });

const downloadFile = (url, destinationPath) =>
  new Promise((resolve, reject) => {
    const client = url.startsWith('https:') ? https : http;

    client
      .get(
        url,
        {
          headers: {
            'User-Agent': 'pg-1bot-backend',
            Accept: 'application/octet-stream',
          },
        },
        (response) => {
          if (response.statusCode && response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
            response.resume();
            resolve(downloadFile(response.headers.location, destinationPath));
            return;
          }

          if (response.statusCode !== 200) {
            response.resume();
            reject(new Error(`No se pudo descargar Arduino CLI. HTTP ${response.statusCode}.`));
            return;
          }

          const fileStream = require('fs').createWriteStream(destinationPath);
          response.pipe(fileStream);

          fileStream.on('finish', () => {
            fileStream.close(resolve);
          });

          fileStream.on('error', (error) => {
            reject(new Error(`No se pudo guardar Arduino CLI descargado: ${error.message}`));
          });
        }
      )
      .on('error', (error) => {
        reject(new Error(`No se pudo descargar Arduino CLI: ${error.message}`));
      });
  });

const extractArchive = async ({ archivePath, destinationDir, archiveType }) => {
  if (archiveType === 'zip') {
    if (process.platform !== 'win32') {
      throw new Error('La extraccion ZIP automatica solo esta implementada para Windows.');
    }

    await execFileAsync(
      'powershell.exe',
      [
        '-NoProfile',
        '-Command',
        `Expand-Archive -LiteralPath '${archivePath.replace(/'/g, "''")}' -DestinationPath '${destinationDir.replace(/'/g, "''")}' -Force`,
      ],
      {
        windowsHide: true,
        maxBuffer: MAX_BUFFER_SIZE,
      }
    );

    return;
  }

  if (archiveType === 'tar.gz') {
    await execFileAsync('tar', ['-xzf', archivePath, '-C', destinationDir], {
      windowsHide: true,
      maxBuffer: MAX_BUFFER_SIZE,
    });
    return;
  }

  throw new Error(`Tipo de archivo no soportado para extraer Arduino CLI: ${archiveType}.`);
};

const fetchReleaseMetadata = async () => {
  const configuredVersion = (process.env.ARDUINO_CLI_VERSION || DEFAULT_RELEASE_VERSION).trim();
  const normalizedVersion =
    configuredVersion.toLowerCase() === 'latest'
      ? 'latest'
      : configuredVersion.startsWith('v')
        ? configuredVersion
        : `v${configuredVersion}`;

  const releaseUrl =
    normalizedVersion === 'latest'
      ? `${GITHUB_RELEASES_API}/latest`
      : `${GITHUB_RELEASES_API}/tags/${normalizedVersion}`;

  return requestJson(releaseUrl);
};

const findDownloadedCliBinary = async (searchRoot) => {
  const files = await listFilesRecursively(searchRoot);
  const expectedName = getCliExecutableName().toLowerCase();

  return files.find((filePath) => path.basename(filePath).toLowerCase() === expectedName) || null;
};

const installArduinoCliBinary = async ({ force = false } = {}) => {
  const installDir = getLocalInstallDir();
  const localCliPath = getLocalCliPath();

  if (!force && (await pathExists(localCliPath))) {
    return {
      cliPath: localCliPath,
      installed: false,
      source: 'managed',
    };
  }

  const releaseLookupTarget = getReleaseLookupTarget();
  const release = await fetchReleaseMetadata();
  const asset = (release.assets || []).find((candidate) =>
    releaseLookupTarget.assetPattern.test(candidate.name || '')
  );

  if (!asset) {
    throw new Error(
      `No se encontro un asset de Arduino CLI compatible con ${process.platform}/${process.arch} en el release ${release.tag_name}.`
    );
  }

  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'arduino-cli-install-'));
  const archivePath = path.join(tempRoot, asset.name);
  const extractDir = path.join(tempRoot, 'extract');

  try {
    await fs.mkdir(extractDir, { recursive: true });
    await downloadFile(asset.browser_download_url, archivePath);
    await extractArchive({
      archivePath,
      destinationDir: extractDir,
      archiveType: releaseLookupTarget.archiveType,
    });

    const extractedCliPath = await findDownloadedCliBinary(extractDir);

    if (!extractedCliPath) {
      throw new Error('Se descargo Arduino CLI, pero no se encontro el ejecutable dentro del paquete.');
    }

    await fs.rm(installDir, { recursive: true, force: true });
    await fs.mkdir(installDir, { recursive: true });
    await fs.copyFile(extractedCliPath, localCliPath);

    if (process.platform !== 'win32') {
      await fs.chmod(localCliPath, 0o755);
    }

    await fs.writeFile(
      path.join(installDir, 'release.json'),
      JSON.stringify(
        {
          installedAt: new Date().toISOString(),
          assetName: asset.name,
          version: release.tag_name,
          platform: process.platform,
          arch: process.arch,
        },
        null,
        2
      )
    );

    return {
      cliPath: localCliPath,
      installed: true,
      source: 'managed',
      version: release.tag_name,
      assetName: asset.name,
    };
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
};

const ensureArduinoCliInstalled = async ({ force = false } = {}) => {
  if (!force) {
    const resolved = await resolveInstalledCliPath();

    if (resolved.source !== 'path' || (await getBinaryStatus(resolved.cliPath)).available) {
      return resolved;
    }
  }

  if (!installPromise || force) {
    installPromise = installArduinoCliBinary({ force }).finally(() => {
      installPromise = null;
    });
  }

  const installed = await installPromise;

  return {
    cliPath: installed.cliPath,
    source: installed.source,
    installed: installed.installed,
    version: installed.version,
    assetName: installed.assetName,
  };
};

const getBinaryStatus = async (cliPath) => {
  try {
    const { stdout, stderr } = await execFileAsync(cliPath, ['version'], {
      windowsHide: true,
      maxBuffer: MAX_BUFFER_SIZE,
    });

    return {
      available: true,
      cliPath,
      raw: (stdout || stderr || '').trim(),
    };
  } catch (error) {
    return {
      available: false,
      cliPath,
      error: error.message,
    };
  }
};

const getCliVersion = async (cliPath) => {
  const { stdout } = await execFileAsync(cliPath, ['version', '--format', 'json'], {
    windowsHide: true,
    maxBuffer: MAX_BUFFER_SIZE,
  });

  const parsed = JSON.parse(stdout);

  return {
    version: parsed.VersionString,
    rawVersionOutput: stdout.trim(),
  };
};

const getCoreIdFromFqbn = (fqbn) => {
  const [vendor, architecture] = String(fqbn || '').split(':');

  if (!vendor || !architecture) {
    throw new Error(`El fqbn "${fqbn}" no tiene el formato esperado para identificar el core.`);
  }

  return `${vendor}:${architecture}`;
};

const listInstalledCores = async (cliPath) => {
  const { stdout } = await execFileAsync(
    cliPath,
    ['core', 'list', '--format', 'json'],
    {
      windowsHide: true,
      maxBuffer: MAX_BUFFER_SIZE,
    }
  );

  if (!stdout.trim()) {
    return [];
  }

  const parsed = JSON.parse(stdout);

  if (Array.isArray(parsed)) {
    return parsed;
  }

  if (parsed.installed && Array.isArray(parsed.installed)) {
    return parsed.installed;
  }

  return [];
};
const ensureCoreInstalledForFqbn = async (cliPath, fqbn) => {
  const coreId = getCoreIdFromFqbn(fqbn);

  const installedCores = await listInstalledCores(cliPath);

  const alreadyInstalled = installedCores.some(
    (core) =>
      core.ID === coreId ||
      core.id === coreId ||
      core.Id === coreId
  );

  if (alreadyInstalled) {
    return {
      coreId,
      installedNow: false,
    };
  }

  await execFileAsync(cliPath, ['core', 'update-index'], {
    windowsHide: true,
    maxBuffer: MAX_BUFFER_SIZE,
  });

  await execFileAsync(cliPath, ['core', 'install', coreId], {
    windowsHide: true,
    maxBuffer: MAX_BUFFER_SIZE,
  });

  return {
    coreId,
    installedNow: true,
  };
};

const compileSketch = async ({ fileName, fileBuffer, fqbn }) => {
  if (!fileBuffer || !fileBuffer.length) {
    throw new Error('No se recibio ningun archivo para compilar.');
  }

  if (!fqbn) {
    throw new Error('Falta el parametro fqbn.');
  }

  const originalExtension = path.extname(fileName || '').toLowerCase();
  if (originalExtension && !['.ino', '.pde'].includes(originalExtension)) {
    throw new Error('Solo se admiten archivos .ino o .pde.');
  }

  const cliResolution = await ensureArduinoCliInstalled();
  const cliPath = cliResolution.cliPath;
  const coreStatus = await ensureCoreInstalledForFqbn(cliPath, fqbn);
  const sketchName = sanitizeSketchName(fileName);
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'arduino-compile-'));
  const sketchDir = path.join(tempRoot, sketchName);
  const sketchFilePath = path.join(sketchDir, `${sketchName}.ino`);
  const outputDir = path.join(tempRoot, 'build');

  try {
    await fs.mkdir(sketchDir, { recursive: true });
    await fs.mkdir(outputDir, { recursive: true });
    await fs.writeFile(sketchFilePath, fileBuffer);

    const { stdout, stderr } = await execFileAsync(
      cliPath,
      ['compile', '-b', fqbn, '--output-dir', outputDir, sketchDir],
      {
        windowsHide: true,
        maxBuffer: MAX_BUFFER_SIZE,
      }
    );

    const artifactPath = await pickCompiledArtifact(outputDir, sketchName);

    if (!artifactPath) {
      throw new Error('La compilacion termino, pero no se encontro un artefacto exportable.');
    }

    const artifactBuffer = await fs.readFile(artifactPath);

    return {
      fileName: path.basename(artifactPath),
      contentType: 'application/octet-stream',
      fileBuffer: artifactBuffer,
      compileLog: [stdout, stderr].filter(Boolean).join('\n').trim(),
      fqbn,
      cliPath,
      coreId: coreStatus.coreId,
      coreInstalledNow: coreStatus.installedNow,
    };
  } catch (error) {
    const details = [error.stdout, error.stderr, error.message].filter(Boolean).join('\n').trim();
    throw new Error(details || 'La compilacion fallo.');
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
};

const installArduinoCli = async ({ force = false } = {}) => {
  const installation = await ensureArduinoCliInstalled({ force });
  const versionInfo = await getCliVersion(installation.cliPath);

  return {
    installed: Boolean(installation.installed),
    cliPath: installation.cliPath,
    source: installation.source,
    version: versionInfo.version,
    rawVersionOutput: versionInfo.rawVersionOutput,
    platform: process.platform,
    arch: process.arch,
  };
};

const getArduinoStatus = async () => {
  const resolved = await resolveInstalledCliPath();
  const binaryStatus = await getBinaryStatus(resolved.cliPath);

  if (!binaryStatus.available) {
    return {
      integrated: true,
      binaryAvailable: false,
      cliPath: binaryStatus.cliPath,
      source: resolved.source,
      canAutoInstall: true,
      managedInstallDir: getLocalInstallDir(),
      platform: process.platform,
      arch: process.arch,
      message:
        resolved.source === 'path'
          ? 'Arduino CLI no esta instalado en PATH ni en la carpeta administrada del backend.'
          : 'La ruta configurada para Arduino CLI no es valida o no se pudo ejecutar.',
      error: binaryStatus.error,
    };
  }

  try {
    const versionInfo = await getCliVersion(binaryStatus.cliPath);

    return {
      integrated: true,
      binaryAvailable: true,
      cliPath: binaryStatus.cliPath,
      source: resolved.source,
      managedInstallDir: getLocalInstallDir(),
      platform: process.platform,
      arch: process.arch,
      version: versionInfo.version,
      rawVersionOutput: versionInfo.rawVersionOutput,
    };
  } catch (error) {
    return {
      integrated: true,
      binaryAvailable: true,
      cliPath: binaryStatus.cliPath,
      source: resolved.source,
      managedInstallDir: getLocalInstallDir(),
      platform: process.platform,
      arch: process.arch,
      message: 'Se encontro el binario, pero no se pudo consultar la version con formato JSON.',
      error: error.message,
    };
  }
};

module.exports = {
  compileSketch,
  getArduinoStatus,
  installArduinoCli,
  ensureArduinoCliInstalled,
};
