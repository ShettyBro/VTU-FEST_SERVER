const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const https = require('https');
const pool = require('../../db/pool');
const { authenticate } = require('../../middleware/auth');
const requireRole = require('../../middleware/requireRole');

async function sendEmailViaBrevo(to, subject, html) {
  const payload = JSON.stringify({
    sender: { email: process.env.FROM_EMAIL, name: 'VTU Fest Team' },
    to: [{ email: to }],
    subject,
    htmlContent: html,
  });

  const options = {
    hostname: 'api.brevo.com',
    port: 443,
    path: '/v3/smtp/email',
    method: 'POST',
    headers: {
      'api-key': process.env.BREVO_API_KEY,
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
        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve({ success: true, status: res.statusCode });
        } else {
          reject(new Error(`Brevo API failed: ${res.statusCode} - ${data}`));
        }
      });
    });

    req.on('error', (err) => {
      reject(new Error(`Brevo request failed: ${err.message}`));
    });

    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Brevo request timeout'));
    });

    req.write(payload);
    req.end();
  });
}

router.use(authenticate);
router.use(requireRole(['PRINCIPAL']));

router.post('/', async (req, res) => {
  const requestId = `REQ-${Date.now()}`;
  let client;

  try {
    const { college_id } = req.user;
    const { manager_name, manager_email, manager_phone } = req.body;

    if (!manager_name || !manager_email || !manager_phone) {
      return res.status(400).json({
        success: false,
        error: 'manager_name, manager_email, and manager_phone are required',
      });
    }

    console.log(`[${requestId}] Assigning manager: ${manager_email}`);

    client = await pool.connect();

    const existingManager = await client.query(
      `SELECT id FROM users WHERE college_id = $1 AND role = 'MANAGER' AND is_active = true`,
      [college_id]
    );

    if (existingManager.rows.length > 0) {
      return res.status(403).json({
        success: false,
        error: 'Team Manager already exists for this college',
      });
    }

    const emailCheck = await client.query(
      `SELECT id FROM users WHERE email = $1`,
      [manager_email]
    );

    if (emailCheck.rows.length > 0) {
      return res.status(403).json({
        success: false,
        error: 'Email already registered',
      });
    }

    const default_password = 'Test@1234';
    const password_hash = await bcrypt.hash(default_password, 12);

    await client.query('BEGIN');

    await client.query(
      `INSERT INTO users (full_name, email, phone, password_hash, role, college_id, is_active, force_password_reset)
       VALUES ($1, $2, $3, $4, 'MANAGER', $5, true, true)`,
      [manager_name, manager_email, manager_phone, password_hash, college_id]
    );

    console.log(`[${requestId}] Sending email via Brevo API...`);

    try {
      await sendEmailViaBrevo(
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
        `
      );

      await client.query('COMMIT');
      console.log(`[${requestId}] SUCCESS: Email sent, transaction committed`);

      return res.status(200).json({
        success: true,
        message: 'Team Manager assigned successfully. Email sent with login credentials.',
      });

    } catch (emailError) {
      await client.query('ROLLBACK');
      console.error(`[${requestId}] Email failed, rolled back:`, emailError.message);

      return res.status(500).json({
        success: false,
        error: 'Failed to send email. Manager assignment cancelled.',
        details: emailError.message,
      });
    }

  } catch (err) {
    if (client) {
      try {
        await client.query('ROLLBACK');
      } catch (rollbackErr) {
        console.error(`[${requestId}] Rollback error:`, rollbackErr.message);
      }
    }

    console.error(`[${requestId}] ERROR:`, err.message);

    return res.status(500).json({
      success: false,
      error: 'Internal server error',
      details: process.env.NODE_ENV === 'development' ? err.message : undefined,
    });

  } finally {
    if (client) {
      client.release();
    }
  }
});

module.exports = router;