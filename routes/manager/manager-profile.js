const express = require('express');
const router = express.Router();
const pool = require('../../db/pool');
const crypto = require('crypto');
const { BlobServiceClient, generateBlobSASQueryParameters, BlobSASPermissions, StorageSharedKeyCredential } = require('@azure/storage-blob');
const { authenticate } = require('../../middleware/auth');
const requireRole = require('../../middleware/requireRole');
const { success, error, validationError } = require('../../utils/response');

// Azure Blob Storage configuration
const STORAGE_ACCOUNT_NAME = process.env.AZURE_STORAGE_ACCOUNT_NAME;
const STORAGE_ACCOUNT_KEY = process.env.AZURE_STORAGE_ACCOUNT_KEY;
const CONTAINER_NAME = 'student-documents';
const SESSION_EXPIRY_MINUTES = 25;

// ============================================================================
// HELPER: Generate Azure Blob SAS URL
// ============================================================================
const generateSASUrl = (blobPath) => {
  const sharedKeyCredential = new StorageSharedKeyCredential(
    STORAGE_ACCOUNT_NAME,
    STORAGE_ACCOUNT_KEY
  );

  const sasOptions = {
    containerName: CONTAINER_NAME,
    blobName: blobPath,
    permissions: BlobSASPermissions.parse('w'), // write only
    startsOn: new Date(Date.now() - 5 * 60 * 1000), // 5 mins ago for clock skew
    expiresOn: new Date(Date.now() + SESSION_EXPIRY_MINUTES * 60 * 1000),
    version: '2021-08-06',
  };

  const sasToken = generateBlobSASQueryParameters(
    sasOptions,
    sharedKeyCredential
  ).toString();

  return `https://${STORAGE_ACCOUNT_NAME}.blob.core.windows.net/${CONTAINER_NAME}/${blobPath}?${sasToken}`;
};

// ============================================================================
// POST /api/manager/manager-profile
// Multi-action endpoint for manager profile completion
// ============================================================================
router.post('/', authenticate, requireRole(['MANAGER']), async (req, res) => {
  const { action } = req.body;
  const { college_id, id: user_id, full_name, phone, email } = req.user;

  if (!action) {
    return validationError(res, 'Action is required');
  }

  try {
    // ========================================================================
    // ACTION: check_profile_status - Check if manager profile completed
    // ========================================================================
    if (action === 'check_profile_status') {
      const result = await pool.query(
        'SELECT id FROM accompanists WHERE college_id = $1 AND is_team_manager = true',
        [college_id]
      );

      return success(res, {
        profile_completed: result.rows.length > 0,
      });
    }

    // ========================================================================
    // ACTION: init_manager_profile - Initialize profile completion session
    // ========================================================================
    if (action === 'init_manager_profile') {
      // Check if profile already completed
      const existingResult = await pool.query(
        'SELECT id FROM accompanists WHERE college_id = $1 AND is_team_manager = true',
        [college_id]
      );

      if (existingResult.rows.length > 0) {
        return error(res, 'Profile already completed', 403);
      }

      // Get college info
      const collegeResult = await pool.query(
        'SELECT college_code, college_name FROM colleges WHERE id = $1',
        [college_id]
      );

      if (collegeResult.rows.length === 0) {
        return error(res, 'College not found', 404);
      }

      const { college_code, college_name } = collegeResult.rows[0];

      // Generate session
      const session_id = crypto.randomBytes(32).toString('hex');
      const expires_at = new Date(Date.now() + SESSION_EXPIRY_MINUTES * 60 * 1000);

      // Store session (using PENDING placeholders for phone/email since they come from user table)
      await pool.query(
        `INSERT INTO accompanist_sessions (
          session_id, college_id, full_name, phone, email, 
          accompanist_type, student_id, expires_at
        )
        VALUES ($1, $2, $3, 'PENDING', 'PENDING', 'faculty', NULL, $4)`,
        [session_id, college_id, full_name, expires_at]
      );

      // Generate SAS URLs for document uploads
      const blobBasePath = `${college_code}/manager-${full_name.replace(/\s+/g, '_')}`;
      const upload_urls = {
        passport_photo: generateSASUrl(`${blobBasePath}/passport_photo`),
        college_id_card: generateSASUrl(`${blobBasePath}/college_id_card`),
        aadhaar_card: generateSASUrl(`${blobBasePath}/aadhaar_card`),
      };

      return success(res, {
        session_id,
        upload_urls,
        expires_at: expires_at.toISOString(),
      });
    }

    // ========================================================================
    // ACTION: finalize_manager_profile - Complete profile setup
    // ========================================================================
    if (action === 'finalize_manager_profile') {
      const { session_id } = req.body;

      if (!session_id) {
        return validationError(res, 'session_id is required');
      }

      // Validate session
      const sessionResult = await pool.query(
        `SELECT expires_at 
         FROM accompanist_sessions 
         WHERE session_id = $1 AND college_id = $2`,
        [session_id, college_id]
      );

      if (sessionResult.rows.length === 0) {
        return error(res, 'Invalid or expired session', 404);
      }

      const expires_at = new Date(sessionResult.rows[0].expires_at);

      if (Date.now() > expires_at.getTime()) {
        return error(res, 'Session expired. Please restart.', 400);
      }

      // Get college info
      const collegeResult = await pool.query(
        'SELECT college_code, college_name FROM colleges WHERE id = $1',
        [college_id]
      );

      const { college_code, college_name } = collegeResult.rows[0];

      // Construct blob URLs
      const blobBasePath = `${college_code}/manager-${full_name.replace(/\s+/g, '_')}`;
      const passport_photo_url = `https://${STORAGE_ACCOUNT_NAME}.blob.core.windows.net/${CONTAINER_NAME}/${blobBasePath}/passport_photo`;
      const aadhaar_url = `https://${STORAGE_ACCOUNT_NAME}.blob.core.windows.net/${CONTAINER_NAME}/${blobBasePath}/aadhaar_card`;
      const college_id_card_url = `https://${STORAGE_ACCOUNT_NAME}.blob.core.windows.net/${CONTAINER_NAME}/${blobBasePath}/college_id_card`;

      // Insert manager as accompanist with is_team_manager = true
      await pool.query(
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

      // Delete session
      await pool.query(
        'DELETE FROM accompanist_sessions WHERE session_id = $1',
        [session_id]
      );

      return success(res, null, 'Profile completed successfully. You are now counted in the 45-person quota.', 201);
    }

    // Invalid action
    return validationError(res, 'Invalid action specified');

  } catch (err) {
    console.error('Manager profile error:', err);
    return error(res, 'Failed to process manager profile request', 500);
  }
});

module.exports = router;