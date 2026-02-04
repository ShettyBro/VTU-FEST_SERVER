const express = require('express');
const router = express.Router();
const pool = require('../../db/pool');
const nodeCrypto = require('crypto');

if (!global.crypto) {
  global.crypto = nodeCrypto.webcrypto;
}

const { BlobServiceClient, generateBlobSASQueryParameters, BlobSASPermissions, StorageSharedKeyCredential } = require('@azure/storage-blob');
const { authenticate } = require('../../middleware/auth');
const requireRole = require('../../middleware/requireRole');

const STORAGE_ACCOUNT_NAME = process.env.AZURE_STORAGE_ACCOUNT_NAME;
const STORAGE_ACCOUNT_KEY = process.env.AZURE_STORAGE_ACCOUNT_KEY;
const CONTAINER_NAME = 'student-documents';
const SESSION_EXPIRY_MINUTES = 25;

const generateSASUrl = (blobPath) => {
  const sharedKeyCredential = new StorageSharedKeyCredential(
    STORAGE_ACCOUNT_NAME,
    STORAGE_ACCOUNT_KEY
  );

  const sasOptions = {
    containerName: CONTAINER_NAME,
    blobName: blobPath,
    permissions: BlobSASPermissions.parse('w'),
    startsOn: new Date(Date.now() - 5 * 60 * 1000),
    expiresOn: new Date(Date.now() + SESSION_EXPIRY_MINUTES * 60 * 1000),
    version: '2021-08-06',
  };

  const sasToken = generateBlobSASQueryParameters(
    sasOptions,
    sharedKeyCredential
  ).toString();

  return `https://${STORAGE_ACCOUNT_NAME}.blob.core.windows.net/${CONTAINER_NAME}/${blobPath}?${sasToken}`;
};

router.post('/', authenticate, requireRole(['MANAGER']), async (req, res) => {
  const { action } = req.body;
  const { college_id, id: user_id, full_name, phone, email } = req.user;

  if (!action) {
    return res.status(400).json({ error: 'Action is required' });
  }

  const client = await pool.connect();

  try {
    if (action === 'check_profile_status') {
      const userResult = await client.query(
        'SELECT profile_completed FROM users WHERE id = $1',
        [user_id]
      );

      const profile_completed = userResult.rows.length > 0 ? userResult.rows[0].profile_completed : false;

      return res.status(200).json({
        success: true,
        profile_completed: profile_completed,
      });
    }

    if (action === 'init_manager_profile') {
      const userResult = await client.query(
        'SELECT profile_completed FROM users WHERE id = $1',
        [user_id]
      );

      if (userResult.rows.length > 0 && userResult.rows[0].profile_completed) {
        return res.status(403).json({ error: 'Profile already completed' });
      }

      const collegeResult = await client.query(
        'SELECT college_code, college_name FROM colleges WHERE id = $1',
        [college_id]
      );

      if (collegeResult.rows.length === 0) {
        return res.status(404).json({ error: 'College not found' });
      }

      const { college_code, college_name } = collegeResult.rows[0];

      const session_id = nodeCrypto.randomBytes(32).toString('hex');
      const expires_at = new Date(Date.now() + SESSION_EXPIRY_MINUTES * 60 * 1000);

      await client.query(
        `INSERT INTO accompanist_sessions (
          session_id, college_id, user_id, full_name, phone, email, 
          accompanist_type, student_id, expires_at
        )
        VALUES ($1, $2, $3, $4, 'PENDING', 'PENDING', 'faculty', NULL, $5)`,
        [session_id, college_id, user_id, full_name, expires_at]
      );

      const blobBasePath = `${college_code}/manager-${full_name.replace(/\s+/g, '_')}`;
      const upload_urls = {
        passport_photo: generateSASUrl(`${blobBasePath}/passport_photo`),
        college_id_card: generateSASUrl(`${blobBasePath}/college_id_card`),
        aadhaar_card: generateSASUrl(`${blobBasePath}/aadhaar_card`),
      };

      return res.status(200).json({
        success: true,
        session_id,
        upload_urls,
        expires_at: expires_at.toISOString(),
      });
    }

    if (action === 'finalize_manager_profile') {
      const { session_id } = req.body;

      if (!session_id) {
        return res.status(400).json({ error: 'session_id is required' });
      }

      const sessionResult = await client.query(
        `SELECT expires_at 
         FROM accompanist_sessions 
         WHERE session_id = $1 AND college_id = $2 AND user_id = $3`,
        [session_id, college_id, user_id]
      );

      if (sessionResult.rows.length === 0) {
        return res.status(404).json({ error: 'Invalid or expired session' });
      }

      const expires_at = new Date(sessionResult.rows[0].expires_at);

      if (Date.now() > expires_at.getTime()) {
        await client.query(
          'DELETE FROM accompanist_sessions WHERE session_id = $1',
          [session_id]
        );
        return res.status(400).json({ error: 'Session expired. Please restart.' });
      }

      const collegeResult = await client.query(
        'SELECT college_code, college_name FROM colleges WHERE id = $1',
        [college_id]
      );

      const { college_code, college_name } = collegeResult.rows[0];

      const blobBasePath = `${college_code}/manager-${full_name.replace(/\s+/g, '_')}`;
      const passport_photo_url = `https://${STORAGE_ACCOUNT_NAME}.blob.core.windows.net/${CONTAINER_NAME}/${blobBasePath}/passport_photo`;
      const aadhaar_url = `https://${STORAGE_ACCOUNT_NAME}.blob.core.windows.net/${CONTAINER_NAME}/${blobBasePath}/aadhaar_card`;
      const college_id_card_url = `https://${STORAGE_ACCOUNT_NAME}.blob.core.windows.net/${CONTAINER_NAME}/${blobBasePath}/college_id_card`;

      await client.query('BEGIN');

      try {
        await client.query(
          `INSERT INTO accompanists (
            college_id,
            college_name,
            full_name,
            phone,
            email,
            accompanist_type,
            passport_photo_url,
            id_proof_url,
            college_id_card_url,
            is_team_manager,
            created_by_user_id,
            created_at
          )
          VALUES ($1, $2, $3, $4, $5, 'faculty', $6, $7, $8, true, $9, NOW())`,
          [
            college_id,
            college_name,
            full_name,
            phone,
            email,
            passport_photo_url,
            aadhaar_url,
            college_id_card_url,
            user_id,
          ]
        );

        await client.query(
          'UPDATE users SET profile_completed = true WHERE id = $1',
          [user_id]
        );

        await client.query(
          'DELETE FROM accompanist_sessions WHERE session_id = $1',
          [session_id]
        );

        await client.query('COMMIT');

        return res.status(200).json({
          success: true,
          message: 'Profile completed successfully. You are now counted in the 45-person quota.',
        });
      } catch (txError) {
        await client.query('ROLLBACK');
        throw txError;
      }
    }

    return res.status(400).json({ error: 'Invalid action specified' });

  } catch (err) {
    console.error('Manager profile error:', err);
    return res.status(500).json({ error: 'Failed to process manager profile request' });
  } finally {
    client.release();
  }
});

module.exports = router;