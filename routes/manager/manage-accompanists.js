const express = require('express');
const router = express.Router();
const nodeCrypto = require('crypto');
if (!global.crypto) {
  global.crypto = nodeCrypto.webcrypto;
}
const pool = require('../../db/pool');
const { BlobServiceClient, generateBlobSASQueryParameters, BlobSASPermissions, StorageSharedKeyCredential } = require('@azure/storage-blob');
const { authenticate } = require('../../middleware/auth');
const requireRole = require('../../middleware/requireRole');
const { success, error, validationError } = require('../../utils/response');

const STORAGE_ACCOUNT_NAME = process.env.AZURE_STORAGE_ACCOUNT_NAME;
const STORAGE_ACCOUNT_KEY = process.env.AZURE_STORAGE_ACCOUNT_KEY;
const CONTAINER_NAME = 'student-documents';
const SESSION_EXPIRY_MINUTES = 25;
const MAX_FILE_SIZE = 5 * 1024 * 1024;

const generateSASUrl = (blobPath) => {
  const sharedKeyCredential = new StorageSharedKeyCredential(
    STORAGE_ACCOUNT_NAME,
    STORAGE_ACCOUNT_KEY
  );

  const sasOptions = {
    containerName: CONTAINER_NAME,
    blobName: blobPath,
    permissions: BlobSASPermissions.parse('cw'),
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

const blobExists = async (blobName) => {
  try {
    const blobServiceClient = BlobServiceClient.fromConnectionString(
      `DefaultEndpointsProtocol=https;AccountName=${STORAGE_ACCOUNT_NAME};AccountKey=${STORAGE_ACCOUNT_KEY};EndpointSuffix=core.windows.net`
    );
    const containerClient = blobServiceClient.getContainerClient(CONTAINER_NAME);
    const blobClient = containerClient.getBlobClient(blobName);
    return await blobClient.exists();
  } catch (err) {
    console.error('Blob exists check error:', err);
    return false;
  }
};

const getBlobSize = async (blobName) => {
  try {
    const blobServiceClient = BlobServiceClient.fromConnectionString(
      `DefaultEndpointsProtocol=https;AccountName=${STORAGE_ACCOUNT_NAME};AccountKey=${STORAGE_ACCOUNT_KEY};EndpointSuffix=core.windows.net`
    );
    const containerClient = blobServiceClient.getContainerClient(CONTAINER_NAME);
    const blobClient = containerClient.getBlobClient(blobName);
    const properties = await blobClient.getProperties();
    return properties.contentLength;
  } catch (err) {
    console.error('Get blob size error:', err);
    return 0;
  }
};

router.post('/', authenticate, requireRole(['MANAGER', 'PRINCIPAL']), async (req, res) => {
  const { action } = req.body;
  const { college_id, id: user_id } = req.user;

  if (!action) {
    return validationError(res, 'Action is required');
  }

  try {
    const lockCheck = await pool.query(
      'SELECT is_final_approved FROM colleges WHERE id = $1',
      [college_id]
    );

    const isLocked = lockCheck.rows.length > 0 && lockCheck.rows[0].is_final_approved === true;

    if (action === 'get_accompanists') {
      const result = await pool.query(
        `SELECT 
          id AS accompanist_id,
          full_name,
          phone,
          email,
          accompanist_type,
          student_id,
          passport_photo_url,
          id_proof_url,
          created_at
        FROM accompanists
        WHERE college_id = $1
        ORDER BY created_at DESC`,
        [college_id]
      );

      return success(res, { accompanists: result.rows, is_locked: isLocked });
    }

    if (isLocked) {
      return error(res, 'Final approval has been completed. Edits are not allowed.', 403);
    }

    if (action === 'init_accompanist') {
      const { full_name, phone, email, accompanist_type, student_id } = req.body;

      if (!full_name || !phone || !accompanist_type) {
        return validationError(res, 'full_name, phone, and accompanist_type are required');
      }

      if (!['faculty', 'professional'].includes(accompanist_type)) {
        return validationError(res, 'accompanist_type must be either "faculty" or "professional"');
      }

      const quotaCheck = await pool.query(
        `SELECT 
          (SELECT COUNT(DISTINCT sa.student_id)
           FROM student_applications sa
           INNER JOIN students s ON sa.student_id = s.id
           WHERE s.college_id = $1 AND sa.status = 'APPROVED') +
          (SELECT COUNT(*)
           FROM accompanists
           WHERE college_id = $1) AS quota_used,
          (SELECT max_quota FROM colleges WHERE id = $1) AS max_quota`,
        [college_id]
      );

      const quota_used = parseInt(quotaCheck.rows[0].quota_used);
      const max_quota = quotaCheck.rows[0].max_quota;

      if (quota_used >= max_quota) {
        return error(res, `College quota exceeded (${quota_used}/${max_quota}). Remove existing participants before adding new ones.`, 403, { quota_used });
      }

      const collegeResult = await pool.query(
        'SELECT college_code, college_name FROM colleges WHERE id = $1',
        [college_id]
      );

      if (collegeResult.rows.length === 0) {
        return error(res, 'College not found', 404);
      }

      const { college_code, college_name } = collegeResult.rows[0];

      const session_id = nodeCrypto.randomBytes(32).toString('hex');
      const expires_at = new Date(Date.now() + SESSION_EXPIRY_MINUTES * 60 * 1000);

      await pool.query(
        `INSERT INTO accompanist_sessions (
          session_id, college_id, full_name, phone, email, accompanist_type, student_id, expires_at, user_id
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [session_id, college_id, full_name, phone, email || null, accompanist_type, student_id || null, expires_at, user_id]
      );

      const blobBasePath = `${college_code}/accompanist-details/${full_name}_${phone}`;
      const upload_urls = {
        passport_photo: generateSASUrl(`${blobBasePath}/passport_photo`),
        government_id_proof: generateSASUrl(`${blobBasePath}/government_id_proof`),
      };

      return success(res, {
        session_id,
        upload_urls,
        expires_at: expires_at.toISOString(),
        quota_remaining: max_quota - quota_used - 1,
      });
    }

    if (action === 'finalize_accompanist') {
      const { session_id } = req.body;

      if (!session_id || typeof session_id !== 'string' || !session_id.trim()) {
        return validationError(res, 'session_id is required');
      }

      const sessionResult = await pool.query(
        `SELECT 
          full_name, phone, email, accompanist_type, student_id, expires_at
        FROM accompanist_sessions
        WHERE session_id = $1 AND college_id = $2`,
        [session_id.trim(), college_id]
      );

      if (sessionResult.rows.length === 0) {
        return error(res, 'Invalid or expired session', 404);
      }

      const session = sessionResult.rows[0];
      const expires_at = new Date(session.expires_at);

      if (Date.now() > expires_at.getTime()) {
        await pool.query(
          'DELETE FROM accompanist_sessions WHERE session_id = $1',
          [session_id.trim()]
        );
        return error(res, 'Session expired. Please restart.', 400);
      }

      const collegeResult = await pool.query(
        'SELECT college_code, college_name FROM colleges WHERE id = $1',
        [college_id]
      );

      const { college_code, college_name } = collegeResult.rows[0];

      const blobBasePath = `${college_code}/accompanist-details/${session.full_name}_${session.phone}`;
      const passportPhotoBlob = `${blobBasePath}/passport_photo`;
      const idProofBlob = `${blobBasePath}/government_id_proof`;

      const passportPhotoExists = await blobExists(passportPhotoBlob);
      if (!passportPhotoExists) {
        return error(res, 'Passport photo not uploaded', 400);
      }

      const idProofExists = await blobExists(idProofBlob);
      if (!idProofExists) {
        return error(res, 'Government ID proof not uploaded', 400);
      }

      const passportPhotoSize = await getBlobSize(passportPhotoBlob);
      if (passportPhotoSize > MAX_FILE_SIZE) {
        return error(res, 'Passport photo exceeds 5MB limit', 400);
      }

      const idProofSize = await getBlobSize(idProofBlob);
      if (idProofSize > MAX_FILE_SIZE) {
        return error(res, 'Government ID proof exceeds 5MB limit', 400);
      }

      const passport_photo_url = `https://${STORAGE_ACCOUNT_NAME}.blob.core.windows.net/${CONTAINER_NAME}/${passportPhotoBlob}`;
      const id_proof_url = `https://${STORAGE_ACCOUNT_NAME}.blob.core.windows.net/${CONTAINER_NAME}/${idProofBlob}`;

      const insertResult = await pool.query(
        `INSERT INTO accompanists (
          college_id,
          college_name,
          created_by_user_id,
          full_name,
          phone,
          email,
          accompanist_type,
          student_id,
          passport_photo_url,
          id_proof_url,
          is_team_manager,
          created_at
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, NOW())
        RETURNING id`,
        [
          college_id,
          college_name,
          user_id,
          session.full_name,
          session.phone,
          session.email,
          session.accompanist_type,
          session.student_id,
          passport_photo_url,
          id_proof_url,
          false,
        ]
      );

      await pool.query(
        'DELETE FROM accompanist_sessions WHERE session_id = $1',
        [session_id.trim()]
      );

      return success(res, {
        message: 'Accompanist added successfully',
        accompanist_id: insertResult.rows[0].id,
      }, 'Accompanist added successfully', 201);
    }

    if (action === 'update_accompanist_details') {
      const { accompanist_id, full_name, phone, email } = req.body;

      if (!accompanist_id) {
        return validationError(res, 'accompanist_id is required');
      }

      if (!full_name || !phone) {
        return validationError(res, 'full_name and phone are required');
      }

      const checkResult = await pool.query(
        'SELECT id FROM accompanists WHERE id = $1 AND college_id = $2',
        [accompanist_id, college_id]
      );

      if (checkResult.rows.length === 0) {
        return error(res, 'Accompanist not found', 404);
      }

      await pool.query(
        `UPDATE accompanists
        SET 
          full_name = $1,
          phone = $2,
          email = $3
        WHERE id = $4`,
        [full_name, phone, email || null, accompanist_id]
      );

      return success(res, null, 'Accompanist details updated successfully');
    }

    if (action === 'delete_accompanist') {
      const { accompanist_id } = req.body;

      if (!accompanist_id) {
        return validationError(res, 'accompanist_id is required');
      }

      const checkResult = await pool.query(
        'SELECT id, is_team_manager FROM accompanists WHERE id = $1 AND college_id = $2',
        [accompanist_id, college_id]
      );

      if (checkResult.rows.length === 0) {
        return error(res, 'Accompanist not found', 404);
      }

      if (checkResult.rows[0].is_team_manager) {
        return error(res, 'Cannot delete team manager profile', 403);
      }

      await pool.query(
        'DELETE FROM accompanists WHERE id = $1',
        [accompanist_id]
      );

      return success(res, null, 'Accompanist deleted successfully');
    }

    return validationError(res, 'Invalid action specified');

  } catch (err) {
    console.error('Manage accompanists error:', err);
    return error(res, 'Failed to process accompanist request', 500);
  }
});

module.exports = router;