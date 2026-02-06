// routes/principal/assign-manager.js
const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const nodemailer = require('nodemailer');
const net = require('net');
const dns = require('dns').promises;
const pool = require('../../db/pool');
const { authenticate } = require('../../middleware/auth');
const requireRole = require('../../middleware/requireRole');
const { success, error, validationError } = require('../../utils/response');

// ============================================================================
// DIAGNOSTIC MODE - SET TO TRUE TO ENABLE DEEP SMTP DEBUGGING
// ============================================================================
const DIAGNOSTIC_MODE = true;

// ============================================================================
// EMAIL TRANSPORTER CONFIGURATION WITH DEEP DEBUGGING
// ============================================================================
const transporterConfig = {
  host: process.env.SMTP_HOST || 'smtp-relay.brevo.com',
  port: Number(process.env.SMTP_PORT) || 587,
  secure: false,
  requireTLS: true,
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
  },
  tls: {
    rejectUnauthorized: false,
    minVersion: 'TLSv1.2',
  },
  connectionTimeout: 15000,
  greetingTimeout: 15000,
  socketTimeout: 15000,
  debug: DIAGNOSTIC_MODE,
  logger: DIAGNOSTIC_MODE,
};

const transporter = nodemailer.createTransport(transporterConfig);

// ============================================================================
// DIAGNOSTIC UTILITY FUNCTIONS
// ============================================================================

/**
 * Test DNS resolution for SMTP host
 */
async function testDNS(host, requestId) {
  console.log(`🔍 [${requestId}] 🌐 DNS: Resolving ${host}...`);
  const dnsStart = Date.now();
  try {
    const addresses = await dns.resolve4(host);
    const dnsTime = Date.now() - dnsStart;
    console.log(`🔍 [${requestId}] ✅ DNS: Resolved to ${addresses.join(', ')} in ${dnsTime}ms`);
    return { success: true, addresses, time: dnsTime };
  } catch (err) {
    const dnsTime = Date.now() - dnsStart;
    console.error(`🔍 [${requestId}] ❌ DNS: Failed in ${dnsTime}ms - ${err.message}`);
    return { success: false, error: err.message, time: dnsTime };
  }
}

/**
 * Test raw TCP connection to SMTP port
 */
async function testTCPConnection(host, port, requestId) {
  console.log(`🔍 [${requestId}] 🔌 TCP: Attempting connection to ${host}:${port}...`);
  const tcpStart = Date.now();
  
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let connected = false;
    
    socket.setTimeout(10000);
    
    socket.on('connect', () => {
      connected = true;
      const tcpTime = Date.now() - tcpStart;
      console.log(`🔍 [${requestId}] ✅ TCP: Connected successfully in ${tcpTime}ms`);
      socket.destroy();
      resolve({ success: true, time: tcpTime });
    });
    
    socket.on('timeout', () => {
      const tcpTime = Date.now() - tcpStart;
      console.error(`🔍 [${requestId}] ❌ TCP: Connection timeout after ${tcpTime}ms`);
      socket.destroy();
      resolve({ success: false, error: 'TCP connection timeout', time: tcpTime });
    });
    
    socket.on('error', (err) => {
      if (!connected) {
        const tcpTime = Date.now() - tcpStart;
        console.error(`🔍 [${requestId}] ❌ TCP: Connection error after ${tcpTime}ms - ${err.message}`);
        socket.destroy();
        resolve({ success: false, error: err.message, time: tcpTime });
      }
    });
    
    socket.connect(port, host);
  });
}

/**
 * Verify SMTP transporter
 */
async function verifyTransporter(requestId) {
  console.log(`🔍 [${requestId}] 📧 SMTP: Verifying transporter...`);
  const verifyStart = Date.now();
  try {
    await transporter.verify();
    const verifyTime = Date.now() - verifyStart;
    console.log(`🔍 [${requestId}] ✅ SMTP: Transporter verified in ${verifyTime}ms`);
    return { success: true, time: verifyTime };
  } catch (err) {
    const verifyTime = Date.now() - verifyStart;
    console.error(`🔍 [${requestId}] ❌ SMTP: Verification failed after ${verifyTime}ms`);
    console.error(`🔍 [${requestId}] ❌ SMTP Error Code: ${err.code}`);
    console.error(`🔍 [${requestId}] ❌ SMTP Error Message: ${err.message}`);
    console.error(`🔍 [${requestId}] ❌ SMTP Error Stack: ${err.stack}`);
    return { success: false, error: err.message, code: err.code, time: verifyTime };
  }
}

/**
 * Run full diagnostic suite
 */
async function runDiagnostics(requestId) {
  console.log(`🔍 [${requestId}] 🔬 DIAGNOSTICS: Starting full SMTP diagnostic suite...`);
  const diagStart = Date.now();
  
  const results = {
    config: {
      host: transporterConfig.host,
      port: transporterConfig.port,
      secure: transporterConfig.secure,
      requireTLS: transporterConfig.requireTLS,
      hasAuth: !!(transporterConfig.auth.user && transporterConfig.auth.pass),
    },
  };
  
  // Test 1: DNS Resolution
  results.dns = await testDNS(transporterConfig.host, requestId);
  
  // Test 2: TCP Connection (only if DNS succeeds)
  if (results.dns.success) {
    results.tcp = await testTCPConnection(transporterConfig.host, transporterConfig.port, requestId);
  } else {
    results.tcp = { success: false, error: 'Skipped due to DNS failure', time: 0 };
  }
  
  // Test 3: SMTP Verification (only if TCP succeeds)
  if (results.tcp.success) {
    results.smtp = await verifyTransporter(requestId);
  } else {
    results.smtp = { success: false, error: 'Skipped due to TCP failure', time: 0 };
  }
  
  const diagTime = Date.now() - diagStart;
  console.log(`🔍 [${requestId}] 🔬 DIAGNOSTICS: Complete in ${diagTime}ms`);
  console.log(`🔍 [${requestId}] 🔬 DIAGNOSTICS SUMMARY:`, JSON.stringify(results, null, 2));
  
  return results;
}

/**
 * Send email using Brevo HTTP API as fallback
 */
async function sendEmailViaBrevoAPI(to, subject, html, requestId) {
  console.log(`🔍 [${requestId}] 🌐 BREVO API: Attempting HTTP fallback...`);
  const apiStart = Date.now();
  
  try {
    const https = require('https');
    const payload = JSON.stringify({
      sender: { email: process.env.FROM_EMAIL, name: 'VTU Fest Team' },
      to: [{ email: to }],
      subject: subject,
      htmlContent: html,
    });
    
    const options = {
      hostname: 'api.brevo.com',
      port: 443,
      path: '/v3/smtp/email',
      method: 'POST',
      headers: {
        'api-key': process.env.BREVO_API_KEY || process.env.SMTP_PASS,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
      },
      timeout: 15000,
    };
    
    return new Promise((resolve, reject) => {
      const req = https.request(options, (res) => {
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => {
          const apiTime = Date.now() - apiStart;
          if (res.statusCode >= 200 && res.statusCode < 300) {
            console.log(`🔍 [${requestId}] ✅ BREVO API: Email sent successfully in ${apiTime}ms`);
            resolve({ success: true, time: apiTime, response: data });
          } else {
            console.error(`🔍 [${requestId}] ❌ BREVO API: Failed with status ${res.statusCode} in ${apiTime}ms`);
            console.error(`🔍 [${requestId}] ❌ BREVO API Response: ${data}`);
            reject(new Error(`Brevo API failed: ${res.statusCode} - ${data}`));
          }
        });
      });
      
      req.on('error', (err) => {
        const apiTime = Date.now() - apiStart;
        console.error(`🔍 [${requestId}] ❌ BREVO API: Request error after ${apiTime}ms - ${err.message}`);
        reject(err);
      });
      
      req.on('timeout', () => {
        const apiTime = Date.now() - apiStart;
        console.error(`🔍 [${requestId}] ❌ BREVO API: Request timeout after ${apiTime}ms`);
        req.destroy();
        reject(new Error('Brevo API timeout'));
      });
      
      req.write(payload);
      req.end();
    });
  } catch (err) {
    const apiTime = Date.now() - apiStart;
    console.error(`🔍 [${requestId}] ❌ BREVO API: Exception after ${apiTime}ms - ${err.message}`);
    throw err;
  }
}

/**
 * Send email with automatic SMTP → HTTP API fallback
 */
async function sendEmailWithFallback(to, subject, html, requestId) {
  console.log(`🔍 [${requestId}] 📧 EMAIL: Attempting to send email to ${to}...`);
  
  // Try SMTP first
  const smtpStart = Date.now();
  try {
    console.log(`🔍 [${requestId}] 📧 EMAIL: Trying SMTP method...`);
    const info = await transporter.sendMail({
      from: process.env.FROM_EMAIL,
      to: to,
      subject: subject,
      html: html,
    });
    const smtpTime = Date.now() - smtpStart;
    console.log(`🔍 [${requestId}] ✅ EMAIL: SMTP succeeded in ${smtpTime}ms`);
    console.log(`🔍 [${requestId}] ✅ EMAIL: MessageId: ${info.messageId}`);
    return { method: 'SMTP', time: smtpTime, messageId: info.messageId };
  } catch (smtpError) {
    const smtpTime = Date.now() - smtpStart;
    console.error(`🔍 [${requestId}] ❌ EMAIL: SMTP failed after ${smtpTime}ms`);
    console.error(`🔍 [${requestId}] ❌ SMTP Error Code: ${smtpError.code}`);
    console.error(`🔍 [${requestId}] ❌ SMTP Error Message: ${smtpError.message}`);
    console.error(`🔍 [${requestId}] ❌ SMTP Error Command: ${smtpError.command}`);
    console.error(`🔍 [${requestId}] ❌ SMTP Full Stack:`, smtpError.stack);
    
    // Fallback to Brevo HTTP API
    console.log(`🔍 [${requestId}] 🔄 EMAIL: Falling back to Brevo HTTP API...`);
    try {
      const apiResult = await sendEmailViaBrevoAPI(to, subject, html, requestId);
      return { method: 'BREVO_API', time: apiResult.time };
    } catch (apiError) {
      console.error(`🔍 [${requestId}] ❌ EMAIL: Both SMTP and API failed`);
      throw new Error(`Email delivery failed. SMTP: ${smtpError.message}. API: ${apiError.message}`);
    }
  }
}

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
  console.log(`🔍 [${requestId}] Diagnostic Mode: ${DIAGNOSTIC_MODE ? 'ENABLED' : 'DISABLED'}`);

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
    
    // Run diagnostics if enabled
    if (DIAGNOSTIC_MODE) {
      await runDiagnostics(requestId);
    }
    
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

    console.log(`🔍 [${requestId}] 📧 Sending email with fallback capability...`);
    const emailStart = Date.now();
    
    try {
      const emailResult = await sendEmailWithFallback(
        manager_email,
        'You have been assigned as Team Manager - VTU Fest 2026',
        `
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
        requestId
      );
      
      const emailTime = Date.now() - emailStart;
      console.log(`🔍 [${requestId}] ✅ Email sent successfully via ${emailResult.method} in ${emailTime}ms`);
      
      await client.query('COMMIT');
      console.log(`🔍 [${requestId}] ✅ Transaction committed`);
      
    } catch (emailError) {
      const emailTime = Date.now() - emailStart;
      console.error(`🔍 [${requestId}] ❌ Email sending failed after ${emailTime}ms:`, emailError.message);
      console.error(`🔍 [${requestId}] ❌ Full error stack:`, emailError.stack);
      
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
    console.error(`🔍 [${requestId}] Stack:`, err.stack);
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