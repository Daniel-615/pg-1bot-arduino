const express = require('express');
const multer = require('multer');
const { compileAndUpload } = require('../controllers/codey.controller');
const verifyToken = require('../middleware/auth');

const router = express.Router();
const upload = multer({ limits: { fileSize: 5 * 1024 * 1024 } });

router.post('/compile', verifyToken, upload.single('file'), compileAndUpload);

module.exports = router;
