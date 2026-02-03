const express = require('express');
const router = express.Router();
const pool = require('../../db/pool');
const crypto = require('crypto');
const { BlobServiceClient, generateBlobSASQueryParameters, BlobSASPermissions, StorageSharedKeyCredential } = require('@azure/storage-blob');
const { authenticate } = require('../../middleware/auth');
const requireRole = require('../../middleware/requireRole');
const checkCollegeLock = require('../../middleware/checkCollegeLock');
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
    permissions: BlobSASPermissions.parse('cw'), // create + write
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
// POST /api/manager/manage-accompanists
// Multi-action endpoint for accompanist management
// ============================================================================
router.post('/', authenticate, requireRole(['MANAGER', 'PRINCIPAL']), checkCollegeLock, async (req, res) => {
  const { action } = req.body;
  const { college_id, id: user_id } = req.user;

  if (!action) {
    return validationError(res, 'Action is required');
  }

  try {
    // ========================================================================
    // ACTION: list - Get all accompanists for the college
    // ========================================================================
    if (action === 'list') {
      const result = await pool.query(
        `SELECT 
          id,
          full_name,
          phone,
          email,
          accompanist_type,
          is_team_manager,
          passport_photo_url,
          id_proof_url,
          college_id_card_url,
          created_at
        FROM accompanists
        WHERE college_id = $1
        ORDER BY created_at DESC`,
        [college_id]
      );

      return success(res, { accompanists: result.rows });
    }

    // ========================================================================
    // ACTION: init_add - Initialize accompanist addition session
    // ========================================================================
    if (action === 'init_add') {
      const { full_name, phone, email, accompanist_type, student_id } = req.body;

      // Validate required fields
      if (!full_name || !phone || !accompanist_type) {
        return validationError(res, 'full_name, phone, and accompanist_type are required');
      }

      // Validate accompanist_type (faculty or professional only)
      if (!['faculty', 'professional'].includes(accompanist_type)) {
        return validationError(res, 'accompanist_type must be either "faculty" or "professional"');
      }

      // Check quota (45 total: approved students + accompanists)
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

      // Store session
      await pool.query(
        `INSERT INTO accompanist_sessions (
          session_id, college_id, full_name, phone, email, accompanist_type, student_id, expires_at
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [session_id, college_id, full_name, phone, email || null, accompanist_type, student_id || null, expires_at]
      );

      // Generate SAS URLs for document uploads
      const timestamp = Date.now();
      const blobBasePath = `${college_code}/accompanist-details/${full_name}_${phone}_${timestamp}`;
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

    // ========================================================================
    // ACTION: finalize_add - Complete accompanist addition
    // ========================================================================
    if (action === 'finalize_add') {
      const { session_id } = req.body;

      if (!session_id) {
        return validationError(res, 'session_id is required');
      }

      // Validate session
      const sessionResult = await pool.query(
        `SELECT 
          full_name, phone, email, accompanist_type, student_id, expires_at
        FROM accompanist_sessions
        WHERE session_id = $1 AND college_id = $2`,
        [session_id, college_id]
      );

      if (sessionResult.rows.length === 0) {
        return error(res, 'Invalid or expired session', 404);
      }

      const session = sessionResult.rows[0];
      const expires_at = new Date(session.expires_at);

      if (Date.now() > expires_at.getTime()) {
        return error(res, 'Session expired. Please restart.', 400);
      }

      // Get college info
      const collegeResult = await pool.query(
        'SELECT college_code, college_name FROM colleges WHERE id = $1',
        [college_id]
      );

      const { college_code, college_name } = collegeResult.rows[0];

      // Construct blob URLs (without timestamp for finalization - match init pattern)
      const blobBasePath = `${college_code}/accompanist-details/${session.full_name}_${session.phone}`;
      const passport_photo_url = `https://${STORAGE_ACCOUNT_NAME}.blob.core.windows.net/${CONTAINER_NAME}/${blobBasePath}/passport_photo`;
      const id_proof_url = `https://${STORAGE_ACCOUNT_NAME}.blob.core.windows.net/${CONTAINER_NAME}/${blobBasePath}/government_id_proof`;

      // Insert accompanist record
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
          false, // is_team_manager
        ]
      );

      // Delete session
      await pool.query(
        'DELETE FROM accompanist_sessions WHERE session_id = $1',
        [session_id]
      );

      return success(res, {
        message: 'Accompanist added successfully',
        accompanist_id: insertResult.rows[0].id,
      }, 'Accompanist added successfully', 201);
    }

    // ========================================================================
    // ACTION: delete - Remove accompanist
    // ========================================================================
    if (action === 'delete') {
      const { accompanist_id } = req.body;

      if (!accompanist_id) {
        return validationError(res, 'accompanist_id is required');
      }

      // Verify accompanist belongs to this college
      const checkResult = await pool.query(
        'SELECT id, is_team_manager FROM accompanists WHERE id = $1 AND college_id = $2',
        [accompanist_id, college_id]
      );

      if (checkResult.rows.length === 0) {
        return error(res, 'Accompanist not found', 404);
      }

      // Prevent deletion of team manager
      if (checkResult.rows[0].is_team_manager) {
        return error(res, 'Cannot delete team manager profile', 403);
      }

      // Hard delete accompanist
      await pool.query(
        'DELETE FROM accompanists WHERE id = $1',
        [accompanist_id]
      );

      return success(res, null, 'Accompanist deleted successfully');
    }

    // Invalid action
    return validationError(res, 'Invalid action specified');

  } catch (err) {
    console.error('Manage accompanists error:', err);
    return error(res, 'Failed to process accompanist request', 500);
  }
});

module.exports = router;