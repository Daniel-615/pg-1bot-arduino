const { compileAndUploadCodey } = require('../services/codey.service');

async function compileAndUpload(req, res) {
  try {
    const result = await compileAndUploadCodey({
      fileName: req.file?.originalname,
      fileBuffer: req.file?.buffer,
      upload: req.body.upload === 'true' || req.body.upload === true,
      port: req.body.port,
    });

    return res.json({
      ok: true,
      message: result.uploadLog ? 'Código compilado y cargado en Codey.' : 'Código de Codey compilado correctamente.',
      ...result,
    });
  } catch (error) {
    return res.status(error.statusCode || 500).json({ ok: false, error: error.message });
  }
}

module.exports = { compileAndUpload };
