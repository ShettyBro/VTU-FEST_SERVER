const express = require('express');
const router = express.Router();
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const { BlobServiceClient, generateBlobSASQueryParameters, BlobSASPermissions, StorageSharedKeyCredential } = require('@azure/storage-blob');
const pool = require('../../db/pool');

const JWT_SECRET = process.env.JWT_SECRET;
const AZURE_STORAGE_ACCOUNT_NAME = process.env.AZURE_STORAGE_ACCOUNT_NAME;
const AZURE_STORAGE_ACCOUNT_KEY = process.env.AZURE_STORAGE_ACCOUNT_KEY;
const CONTAINER_NAME = 'student-documents';

// ============================================================================
// 25 EVENT TABLES (MATCHING AZURE ORIGINAL - ABBREVIATED NAMES)
// ============================================================================
const EVENT_TABLES = [
  'event_classical_vocal_solo',
  'event_light_vocal_solo',
  'event_western_vocal_solo',
  'event_classical_instr_percussion',           // ✅ ABBREVIATED (Azure naming)
  'event_classical_instr_non_percussion',       // ✅ ABBREVIATED (Azure naming)
  'event_folk_orchestra',
  'event_group_song_indian',
  'event_group_song_western',
  'event_folk_dance',                           // ✅ SHORT NAME (Azure naming)
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
// MIDDLEWARE: Verify JWT and Student Role
// ============================================================================
const verifyStudentAuth = (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;
    
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({
        success: false,
        message: 'Token expired. Redirecting to login...',
        redirect: 'https://vtufest2026.acharyahabba.com/',
      });
    }

    const token = authHeader.substring(7);
    let decoded;

    try {
      decoded = jwt.verify(token, JWT_SECRET);
    } catch (err) {
      return res.status(401).json({
        success: false,
        message: 'Token expired. Redirecting to login...',
        redirect: 'https://vtufest2026.acharyahabba.com/',
      });
    }

    if (decoded.role !== 'STUDENT') {
      return res.status(403).json({
        success: false,
        error: 'Unauthorized: Student role required',
      });
    }

    req.auth = {
      user_id: decoded.user_id,
      student_id: decoded.student_id,
      college_id: decoded.college_id,
      role: decoded.role,
    };

    next();
  } catch (error) {
    return res.status(500).json({
      success: false,
      error: 'Authentication error',
      details: error.message,
    });
  }
};

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

  const expiresOn = new Date(Date.now() + 25 * 60 * 1000);

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
    const { college_id, student_id } = req.auth;

    const collegeResult = await client.query(
      `SELECT college_code, college_name, is_final_approved
       FROM colleges
       WHERE id = $1`,
      [college_id]
    );

    if (collegeResult.rows.length === 0) {
      return res.status(404).json({
        success: false,
        error: 'College not found',
      });
    }

    const college = collegeResult.rows[0];

    if (!college.is_final_approved) {
      return res.status(200).json({
        success: true,
        can_upload: false,
        message: 'Final approval not done yet. Payment is locked.',
      });
    }

    const eventCheckQueries = EVENT_TABLES.map(table => 
      `SELECT '${table}' AS event_table_name WHERE EXISTS (
        SELECT 1 FROM ${table} WHERE college_id = $1
      )`
    );

    const unionQuery = eventCheckQueries.join(' UNION ALL ');
    const eventsResult = await client.query(unionQuery, [college_id]);

    const participating_event_keys = eventsResult.rows.map(row => row.event_table_name);
    const total_events = participating_event_keys.length;

    const amount_to_pay = total_events < 10 ? 8000 : 25000;

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

    return res.status(200).json({
      success: true,
      can_upload: true,
      total_events,
      participating_event_keys,
      amount_to_pay,
      payment_status,
    });
  } catch (error) {
    console.error('get_payment_info error:', error);
    return res.status(500).json({
      success: false,
      error: 'Internal server error',
      details: error.message,
    });
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
    const { college_id } = req.auth;
    const { amount_paid, utr_reference_number } = req.body;

    if (!amount_paid || !utr_reference_number) {
      return res.status(400).json({
        success: false,
        error: 'amount_paid and utr_reference_number are required',
      });
    }

    const collegeResult = await client.query(
      `SELECT college_code, college_name, is_final_approved
       FROM colleges
       WHERE id = $1`,
      [college_id]
    );

    if (collegeResult.rows.length === 0) {
      return res.status(404).json({
        success: false,
        error: 'College not found',
      });
    }

    const college = collegeResult.rows[0];

    if (!college.is_final_approved) {
      return res.status(403).json({
        success: false,
        error: 'Final approval not done yet. Cannot upload payment.',
      });
    }

    const existingResult = await client.query(
      `SELECT id FROM payment_receipts WHERE college_id = $1`,
      [college_id]
    );

    if (existingResult.rows.length > 0) {
      return res.status(403).json({
        success: false,
        error: 'Payment receipt already uploaded for this college',
      });
    }

    const session_id = crypto.randomBytes(32).toString('hex');
    const expires_at = new Date(Date.now() + 25 * 60 * 1000);

    await client.query(
      `INSERT INTO payment_sessions (session_id, college_id, amount_paid, utr_reference_number, expires_at)
       VALUES ($1, $2, $3, $4, $5)`,
      [session_id, college_id, parseInt(amount_paid), utr_reference_number, expires_at]
    );

    const blobPath = `${college.college_code}/payment-proofs/payment_proof`;
    const upload_url = generateSASUrl(blobPath);

    return res.status(200).json({
      success: true,
      session_id,
      upload_url,
      expires_at: expires_at.toISOString(),
    });
  } catch (error) {
    console.error('init_payment_upload error:', error);
    return res.status(500).json({
      success: false,
      error: 'Internal server error',
      details: error.message,
    });
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
    const { college_id, student_id } = req.auth;
    const { session_id } = req.body;

    if (!session_id) {
      return res.status(400).json({
        success: false,
        error: 'session_id is required',
      });
    }

    const sessionResult = await client.query(
      `SELECT amount_paid, utr_reference_number, expires_at
       FROM payment_sessions
       WHERE session_id = $1 AND college_id = $2`,
      [session_id, college_id]
    );

    if (sessionResult.rows.length === 0) {
      return res.status(404).json({
        success: false,
        error: 'Invalid or expired session',
      });
    }

    const session = sessionResult.rows[0];
    const expires_at = new Date(session.expires_at);

    if (Date.now() > expires_at.getTime()) {
      return res.status(400).json({
        success: false,
        error: 'Session expired. Please restart.',
      });
    }

    const existingPayment = await client.query(
      `SELECT id FROM payment_receipts WHERE college_id = $1`,
      [college_id]
    );

    if (existingPayment.rows.length > 0) {
      return res.status(403).json({
        success: false,
        error: 'Payment receipt already exists for this college',
      });
    }

    const collegeResult = await client.query(
      `SELECT college_code, college_name FROM colleges WHERE id = $1`,
      [college_id]
    );

    const college = collegeResult.rows[0];

    // ✅ FIXED: Query students table instead of users table
    const studentResult = await client.query(
      `SELECT full_name FROM students WHERE id = $1`,
      [student_id]
    );

    const uploaded_by_name = studentResult.rows[0]?.full_name || 'Unknown';

    const receipt_url = `https://${AZURE_STORAGE_ACCOUNT_NAME}.blob.core.windows.net/${CONTAINER_NAME}/${college.college_code}/payment-proofs/payment_proof`;

    await client.query(
      `INSERT INTO payment_receipts (
        college_id, college_code, college_name, receipt_url,
        amount_paid, utr_reference_number, uploaded_by_name,
        uploaded_by_type, status
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, 'STUDENT', 'waiting_for_verification')`,
      [
        college_id,
        college.college_code,
        college.college_name,
        receipt_url,
        session.amount_paid,
        session.utr_reference_number,
        uploaded_by_name,
      ]
    );

    await client.query(
      `DELETE FROM payment_sessions WHERE session_id = $1`,
      [session_id]
    );

    return res.status(200).json({
      success: true,
      message: 'Payment receipt uploaded successfully. Waiting for verification.',
    });
  } catch (error) {
    console.error('finalize_payment error:', error);
    return res.status(500).json({
      success: false,
      error: 'Internal server error',
      details: error.message,
    });
  } finally {
    client.release();
  }
};

// ============================================================================
// MAIN ROUTE: POST /api/student/payment
// ============================================================================
router.post('/payment', verifyStudentAuth, async (req, res) => {
  const { action } = req.body;

  if (!action) {
    return res.status(400).json({
      success: false,
      error: 'action is required',
    });
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
        return res.status(400).json({
          success: false,
          error: 'Invalid action',
        });
    }
  } catch (error) {
    console.error('Payment route error:', error);
    return res.status(500).json({
      success: false,
      error: 'Internal server error',
      details: error.message,
    });
  }
});

module.exports = router;