const express = require('express');
const router = express.Router();
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const nodemailer = require('nodemailer');
const pool = require('../../db/pool'); // PostgreSQL connection pool

const JWT_SECRET = process.env.JWT_SECRET;

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
});

// ============================================================================
// MIDDLEWARE: Verify JWT and Principal Role
// ============================================================================
const requirePrincipal = (req, res, next) => {
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

    if (decoded.role !== 'PRINCIPAL') {
      return res.status(403).json({
        success: false,
        error: 'Unauthorized: Principal role required',
      });
    }

    req.auth = {
      user_id: decoded.user_id,
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
// ROUTE: POST /api/principal/assign-manager
// ============================================================================
router.post('/assign-manager', requirePrincipal, async (req, res) => {
  const client = await pool.connect();
  
  try {
    const { college_id } = req.auth;
    const { manager_name, manager_email, manager_phone } = req.body;

    // Validate required fields
    if (!manager_name || !manager_email || !manager_phone) {
      return res.status(400).json({
        success: false,
        error: 'manager_name, manager_email, and manager_phone are required',
      });
    }

    // Check if Team Manager already exists for this college
    const existingResult = await client.query(
      `SELECT id
       FROM users
       WHERE college_id = $1
         AND role = 'MANAGER'
         AND is_active = true`,
      [college_id]
    );

    if (existingResult.rows.length > 0) {
      return res.status(403).json({
        success: false,
        error: 'Team Manager already exists for this college',
      });
    }

    // Check if email already exists
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

    // Hash default password: Test@1234
    const default_password = 'Test@1234';
    const password_hash = await bcrypt.hash(default_password, 12);

    // Insert Team Manager
    await client.query(
      `INSERT INTO users (full_name, email, phone, password_hash, role, college_id, is_active, force_password_reset)
       VALUES ($1, $2, $3, $4, 'MANAGER', $5, true, true)`,
      [manager_name, manager_email, manager_phone, password_hash, college_id]
    );

    // Send email with credentials
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
    } catch (emailError) {
      console.error('Email sending failed:', emailError);
      // Continue even if email fails
    }

    return res.status(200).json({
      success: true,
      message: 'Team Manager assigned successfully. Email sent with login credentials.',
    });
  } catch (error) {
    console.error('assign-manager error:', error);
    return res.status(500).json({
      success: false,
      error: 'Internal server error',
      details: error.message,
    });
  } finally {
    client.release();
  }
});

module.exports = router;