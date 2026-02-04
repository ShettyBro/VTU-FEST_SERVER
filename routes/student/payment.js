// routes/student/payment.js
// ✅ PRODUCTION-READY: Payment route accessible by MANAGER and PRINCIPAL only
// Despite being in /api/student/payment, this is actually a SHARED route for managers/principals

const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const { BlobServiceClient, generateBlobSASQueryParameters, BlobSASPermissions, StorageSharedKeyCredential } = require('@azure/storage-blob');
const pool = require('../../db/pool');
const { authenticate } = require('../../middleware/auth');
const requireRole = require('../../middleware/requireRole');
const { success, error, validationError } = require('../../utils/response');

// ============================================================================
// AZURE BLOB STORAGE CONFIGURATION
// ============================================================================
const AZURE_STORAGE_ACCOUNT_NAME = process.env.AZURE_STORAGE_ACCOUNT_NAME;
const AZURE_STORAGE_ACCOUNT_KEY = process.env.AZURE_STORAGE_ACCOUNT_KEY;
const CONTAINER_NAME = 'student-documents';
const SESSION_EXPIRY_MINUTES = 25;

// ============================================================================
// 25 EVENT TABLES (MATCHING POSTGRESQL DATABASE - ABBREVIATED NAMES)
// ============================================================================
const EVENT_TABLES = [
  'event_classical_vocal_solo',
  'event_light_vocal_solo',
  'event_western_vocal_solo',
  'event_classical_instr_percussion',           // ✅ ABBREVIATED (PostgreSQL naming)
  'event_classical_instr_non_percussion',       // ✅ ABBREVIATED (PostgreSQL naming)
  'event_folk_orchestra',
  'event_group_song_indian',
  'event_group_song_western',
  'event_folk_dance',                           // ✅ SHORT NAME (PostgreSQL naming)
  'event_classical_dance_solo',
  'event_mime',
  'event_mimicry',
  'event_one_act_play',
  'event_skits',
  'event_debate',
  'event_elocution',
  'event_quiz',
  'event_cartooning',
  'event_clay_modelling',
  'event_collage_making',
  'event_installation',
  'event_on_spot_painting',
  'event_poster_making',
  'event_rangoli',
  'event_spot_photography',
];

// ============================================================================
// HELPER: Generate Azure Blob SAS URL
// ============================================================================
const generateSASUrl = (blobPath) => {
  const sharedKeyCredential = new StorageSharedKeyCredential(
    AZURE_STORAGE_ACCOUNT_NAME,
    AZURE_STORAGE_ACCOUNT_KEY
  );

  const blobServiceClient = new BlobServiceClient(
    `https://${AZURE_STORAGE_ACCOUNT_NAME}.blob.core.windows.net`,
    sharedKeyCredential
  );

  const containerClient = blobServiceClient.getContainerClient(CONTAINER_NAME);
  const blobClient = containerClient.getBlobClient(blobPath);

  const expiresOn = new Date(Date.now() + SESSION_EXPIRY_MINUTES * 60 * 1000);

  const sasToken = generateBlobSASQueryParameters(
    {
      containerName: CONTAINER_NAME,
      blobName: blobPath,
      permissions: BlobSASPermissions.parse('w'),
      expiresOn,
    },
    sharedKeyCredential
  ).toString();

  return `${blobClient.url}?${sasToken}`;
};

// ============================================================================
// ACTION: get_payment_info
// ============================================================================
const getPaymentInfo = async (req, res) => {
  const client = await pool.connect();
  
  try {
    const { college_id } = req.user;

    // Get college info and approval status
    const collegeResult = await client.query(
      `SELECT college_code, college_name, is_final_approved
       FROM colleges
       WHERE id = $1`,
      [college_id]
    );

    if (collegeResult.rows.length === 0) {
      return error(res, 'College not found', 404);
    }

    const college = collegeResult.rows[0];

    // Check if final approval is done
    if (!college.is_final_approved) {
      return success(res, {
        can_upload: false,
        message: 'Final approval not done yet. Payment is locked.',
      });
    }

    // ============================================================================
    // COUNT PARTICIPATING EVENTS (DISTINCT EVENTS WITH COLLEGE PARTICIPATION)
    // ============================================================================
    const eventCheckQueries = EVENT_TABLES.map(table => 
      `SELECT '${table}' AS event_table_name WHERE EXISTS (
        SELECT 1 FROM ${table} WHERE college_id = $1
      )`
    );

    const unionQuery = eventCheckQueries.join(' UNION ALL ');
    const eventsResult = await client.query(unionQuery, [college_id]);

    const participating_event_keys = eventsResult.rows.map(row => row.event_table_name);
    const total_events = participating_event_keys.length;

    // Calculate fee based on event count
    const amount_to_pay = total_events < 10 ? 8000 : 25000;

    // Get existing payment status
    const paymentResult = await client.query(
      `SELECT 
        status,
        uploaded_at,
        admin_remarks,
        receipt_url,
        amount_paid,
        utr_reference_number
       FROM payment_receipts
       WHERE college_id = $1`,
      [college_id]
    );

    let payment_status = null;
    if (paymentResult.rows.length > 0) {
      const pay = paymentResult.rows[0];
      payment_status = {
        status: pay.status,
        uploaded_at: pay.uploaded_at,
        admin_remarks: pay.admin_remarks,
        receipt_url: pay.receipt_url,
        amount_paid: pay.amount_paid,
        utr_reference_number: pay.utr_reference_number,
      };
    }

    return success(res, {
      can_upload: true,
      total_events,
      participating_event_keys,
      amount_to_pay,
      payment_status,
    });
  } catch (err) {
    console.error('get_payment_info error:', err);
    return error(res, 'Internal server error', 500);
  } finally {
    client.release();
  }
};

// ============================================================================
// ACTION: init_payment_upload
// ============================================================================
const initPaymentUpload = async (req, res) => {
  const client = await pool.connect();
  
  try {
    const { college_id } = req.user;
    const { amount_paid, utr_reference_number } = req.body;

    // Validate required fields
    if (!amount_paid || !utr_reference_number) {
      return validationError(res, 'amount_paid and utr_reference_number are required');
    }

    // Get college info and check approval status
    const collegeResult = await client.query(
      `SELECT college_code, college_name, is_final_approved
       FROM colleges
       WHERE id = $1`,
      [college_id]
    );

    if (collegeResult.rows.length === 0) {
      return error(res, 'College not found', 404);
    }

    const college = collegeResult.rows[0];

    // Check if final approval is done
    if (!college.is_final_approved) {
      return error(res, 'Final approval not done yet. Cannot upload payment.', 403);
    }

    // Check if payment already exists for this college
    const existingResult = await client.query(
      `SELECT id FROM payment_receipts WHERE college_id = $1`,
      [college_id]
    );

    if (existingResult.rows.length > 0) {
      return error(res, 'Payment receipt already uploaded for this college', 403);
    }

    // Generate session
    const session_id = crypto.randomBytes(32).toString('hex');
    const expires_at = new Date(Date.now() + SESSION_EXPIRY_MINUTES * 60 * 1000);

    // Store session in database
    await client.query(
      `INSERT INTO payment_sessions (session_id, college_id, amount_paid, utr_reference_number, expires_at)
       VALUES ($1, $2, $3, $4, $5)`,
      [session_id, college_id, parseInt(amount_paid), utr_reference_number, expires_at]
    );

    // Generate Azure Blob SAS URL for upload
    const blobPath = `${college.college_code}/payment-proofs/payment_proof`;
    const upload_url = generateSASUrl(blobPath);

    return success(res, {
      session_id,
      upload_url,
      expires_at: expires_at.toISOString(),
    });
  } catch (err) {
    console.error('init_payment_upload error:', err);
    return error(res, 'Internal server error', 500);
  } finally {
    client.release();
  }
};

// ============================================================================
// ACTION: finalize_payment
// ============================================================================
const finalizePayment = async (req, res) => {
  const client = await pool.connect();
  
  try {
    const { college_id, id: user_id, role, full_name } = req.user;
    const { session_id } = req.body;

    if (!session_id) {
      return validationError(res, 'session_id is required');
    }

    // Validate session
    const sessionResult = await client.query(
      `SELECT amount_paid, utr_reference_number, expires_at
       FROM payment_sessions
       WHERE session_id = $1 AND college_id = $2`,
      [session_id, college_id]
    );

    if (sessionResult.rows.length === 0) {
      return error(res, 'Invalid or expired session', 404);
    }

    const session = sessionResult.rows[0];
    const expires_at = new Date(session.expires_at);

    // Check if session expired
    if (Date.now() > expires_at.getTime()) {
      return error(res, 'Session expired. Please restart.', 400);
    }

    // Check if payment already exists (race condition protection)
    const existingPayment = await client.query(
      `SELECT id FROM payment_receipts WHERE college_id = $1`,
      [college_id]
    );

    if (existingPayment.rows.length > 0) {
      return error(res, 'Payment receipt already exists for this college', 403);
    }

    // Get college info
    const collegeResult = await client.query(
      `SELECT college_code, college_name FROM colleges WHERE id = $1`,
      [college_id]
    );

    const college = collegeResult.rows[0];

    // ✅ FIXED: Use full_name from req.user (set by authenticate middleware from users table)
    const uploaded_by_name = full_name || 'Unknown';

    // Construct receipt URL (blob already uploaded by frontend)
    const receipt_url = `https://${AZURE_STORAGE_ACCOUNT_NAME}.blob.core.windows.net/${CONTAINER_NAME}/${college.college_code}/payment-proofs/payment_proof`;

    // Insert payment receipt record
    await client.query(
      `INSERT INTO payment_receipts (
        college_id, college_code, college_name, receipt_url,
        amount_paid, utr_reference_number, uploaded_by_name,
        uploaded_by_type, status
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'waiting_for_verification')`,
      [
        college_id,
        college.college_code,
        college.college_name,
        receipt_url,
        session.amount_paid,
        session.utr_reference_number,
        uploaded_by_name,
        role, // uploaded_by_type = 'MANAGER' or 'PRINCIPAL'
      ]
    );

    // Delete session after successful insert
    await client.query(
      `DELETE FROM payment_sessions WHERE session_id = $1`,
      [session_id]
    );

    return success(res, {
      message: 'Payment receipt uploaded successfully. Waiting for verification.',
    });
  } catch (err) {
    console.error('finalize_payment error:', err);
    return error(res, 'Internal server error', 500);
  } finally {
    client.release();
  }
};

// ============================================================================
// MAIN ROUTE: POST /api/student/payment
// ============================================================================
router.post('/', authenticate, requireRole(['MANAGER', 'PRINCIPAL']), async (req, res) => {
  const { action } = req.body;

  if (!action) {
    return validationError(res, 'action is required');
  }

  try {
    switch (action) {
      case 'get_payment_info':
        return await getPaymentInfo(req, res);
      
      case 'init_payment_upload':
        return await initPaymentUpload(req, res);
      
      case 'finalize_payment':
        return await finalizePayment(req, res);
      
      default:
        return validationError(res, 'Invalid action');
    }
  } catch (err) {
    console.error('Payment route error:', err);
    return error(res, 'Internal server error', 500);
  }
});

module.exports = router;