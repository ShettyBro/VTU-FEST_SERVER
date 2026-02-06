// routes/principal/assign-manager.js
const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const nodemailer = require('nodemailer');
const pool = require('../../db/pool');
const { authenticate } = require('../../middleware/auth');
const requireRole = require('../../middleware/requireRole');
const { success, error, validationError } = require('../../utils/response');

// ============================================================================
// EMAIL TRANSPORTER CONFIGURATION
// ============================================================================
const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: Number(process.env.SMTP_PORT),
  secure: false,
  requireTLS: true,
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
  },
  tls: {
    rejectUnauthorized: false,
  },
  connectionTimeout: 10000,
  greetingTimeout: 10000,
  socketTimeout: 10000,
});

// Apply middleware
router.use(authenticate);
router.use(requireRole(['PRINCIPAL']));

// ============================================================================
// POST /api/principal/assign-manager
// Assign a Team Manager to the college
// ============================================================================
router.post('/', async (req, res) => {
  const requestId = `REQ-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  const startTime = Date.now();
  
  console.log('┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(`🔍 [${requestId}] ASSIGN-MANAGER: Request started`);
  console.log(`🔍 [${requestId}] Timestamp: ${new Date().toISOString()}`);
  console.log(`🔍 [${requestId}] User ID: ${req.user?.id}`);
  console.log(`🔍 [${requestId}] College ID: ${req.user?.college_id}`);

  let client;
  const dbConnectStart = Date.now();
  
  try {
    const { college_id } = req.user;
    const { manager_name, manager_email, manager_phone } = req.body;

    if (!manager_name || !manager_email || !manager_phone) {
      const totalTime = Date.now() - startTime;
      console.log(`🔍 [${requestId}] ❌ Validation failed - Total time: ${totalTime}ms`);
      return validationError(res, 'manager_name, manager_email, and manager_phone are required');
    }

    console.log(`🔍 [${requestId}] 📋 Manager details: ${manager_name} <${manager_email}>`);
    console.log(`🔍 [${requestId}] 🔌 Acquiring database connection...`);
    
    client = await pool.connect();
    const dbConnectTime = Date.now() - dbConnectStart;
    console.log(`🔍 [${requestId}] ✅ Database connected in ${dbConnectTime}ms`);

    console.log(`🔍 [${requestId}] 🔎 Checking for existing manager...`);
    const existingResult = await client.query(
      `SELECT id
       FROM users
       WHERE college_id = $1
         AND role = 'MANAGER'
         AND is_active = true`,
      [college_id]
    );

    if (existingResult.rows.length > 0) {
      const totalTime = Date.now() - startTime;
      console.log(`🔍 [${requestId}] ⚠️ Manager already exists - Total time: ${totalTime}ms`);
      console.log('┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
      
      return res.status(403).json({
        success: false,
        error: 'Team Manager already exists for this college',
        requestId,
      });
    }

    console.log(`🔍 [${requestId}] 🔎 Checking email availability...`);
    const emailCheck = await client.query(
      `SELECT id FROM users WHERE email = $1`,
      [manager_email]
    );

    if (emailCheck.rows.length > 0) {
      const totalTime = Date.now() - startTime;
      console.log(`🔍 [${requestId}] ⚠️ Email already registered - Total time: ${totalTime}ms`);
      console.log('┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
      
      return res.status(403).json({
        success: false,
        error: 'Email already registered',
        requestId,
      });
    }

    console.log(`🔍 [${requestId}] 🔐 Hashing password...`);
    const hashStart = Date.now();
    const default_password = 'Test@1234';
    const password_hash = await bcrypt.hash(default_password, 12);
    const hashTime = Date.now() - hashStart;
    console.log(`🔍 [${requestId}] ✅ Password hashed in ${hashTime}ms`);

    console.log(`🔍 [${requestId}] 🔄 Starting transaction...`);
    await client.query('BEGIN');

    console.log(`🔍 [${requestId}] 💾 Inserting manager record...`);
    const insertStart = Date.now();
    await client.query(
      `INSERT INTO users (full_name, email, phone, password_hash, role, college_id, is_active, force_password_reset)
       VALUES ($1, $2, $3, $4, 'MANAGER', $5, true, true)`,
      [manager_name, manager_email, manager_phone, password_hash, college_id]
    );
    const insertTime = Date.now() - insertStart;
    console.log(`🔍 [${requestId}] ✅ Manager inserted in ${insertTime}ms (not committed yet)`);

    console.log(`🔍 [${requestId}] 📧 Sending email...`);
    const emailStart = Date.now();
    
    try {
      await transporter.sendMail({
        from: process.env.FROM_EMAIL,
        to: manager_email,
        subject: 'You have been assigned as Team Manager - VTU Fest 2026',
        html: `
          <h2>Welcome to VTU Fest 2026!</h2>
          <p>Dear ${manager_name},</p>
          <p>You have been assigned as <strong>Team Manager</strong> for your college.</p>
          <h3>Your Login Credentials:</h3>
          <ul>
            <li><strong>Email:</strong> ${manager_email}</li>
            <li><strong>Password:</strong> ${default_password}</li>
          </ul>
          <p><a href="https://vtufest2026.acharyahabba.com/">Login here</a></p>
          <p><strong>IMPORTANT:</strong> You must change your password on first login.</p>
          <p>Best regards,<br>VTU Fest Team</p>
        `,
      });
      
      const emailTime = Date.now() - emailStart;
      console.log(`🔍 [${requestId}] ✅ Email sent successfully in ${emailTime}ms`);
      
      await client.query('COMMIT');
      console.log(`🔍 [${requestId}] ✅ Transaction committed`);
      
    } catch (emailError) {
      const emailTime = Date.now() - emailStart;
      console.error(`🔍 [${requestId}] ❌ Email sending failed after ${emailTime}ms:`, emailError.message);
      
      await client.query('ROLLBACK');
      console.log(`🔍 [${requestId}] ↩ Transaction rolled back`);
      
      const totalTime = Date.now() - startTime;
      console.log(`🔍 [${requestId}] ❌ Assignment failed - Total time: ${totalTime}ms`);
      console.log('┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
      
      return res.status(500).json({
        success: false,
        error: 'Failed to send email. Manager assignment cancelled.',
        details: emailError.message,
        requestId,
      });
    }

    const totalTime = Date.now() - startTime;
    console.log(`🔍 [${requestId}] ✅ Manager assigned successfully`);
    console.log(`🔍 [${requestId}] ⏱️ Total request time: ${totalTime}ms`);
    console.log('┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

    return res.status(200).json({
      success: true,
      message: 'Team Manager assigned successfully. Email sent with login credentials.',
      _debug: {
        requestId,
        timings: {
          db_connect_ms: dbConnectTime,
          hash_ms: hashTime,
          insert_ms: insertTime,
          total_ms: totalTime,
        },
      },
    });

  } catch (err) {
    const elapsed = Date.now() - startTime;
    
    if (client) {
      try {
        await client.query('ROLLBACK');
        console.log(`🔍 [${requestId}] ↩ Transaction rolled back due to error`);
      } catch (rollbackErr) {
        console.error(`🔍 [${requestId}] ❌ Rollback failed:`, rollbackErr.message);
      }
    }
    
    console.error('┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.error(`🔍 [${requestId}] ❌ ERROR after ${elapsed}ms`);
    console.error(`🔍 [${requestId}] Error:`, err);
    console.error('┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

    return res.status(500).json({
      success: false,
      error: 'Internal server error',
      requestId,
      details: process.env.NODE_ENV === 'development' ? err.message : undefined,
    });

  } finally {
    if (client) {
      client.release();
      console.log(`🔍 [${requestId}] 🔌 Database connection released`);
    }
  }
});

module.exports = router;