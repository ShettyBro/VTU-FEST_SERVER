// routes/auth/forgot-password.js
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const nodemailer = require("nodemailer");
const pool = require('../../db/pool');

const FRONTEND_URL = process.env.FRONTEND_URL || 'https://vtufest2026.acharyahabba.com/changepassword';
const TOKEN_EXPIRY_MINUTES = 15;
const ALLOWED_ROLES = ['student', 'manager', 'principal', 'admin', 'sub_admin'];


const getRoleTable = (role) => {
  if (role === 'student') return 'students';
  return 'users';
};

const getRoleIdColumn = (role) => {
  if (role === 'student') return 'student_id';
  return 'user_id';
};

module.exports = async (req, res) => {
  const role = req.params.role;

  if (!ALLOWED_ROLES.includes(role)) {
    return res.status(400).json({ error: 'Invalid role' });
  }

  const { email } = req.body;

  if (!email || typeof email !== 'string' || !email.trim()) {
    return res.status(400).json({ error: 'Email is required' });
  }

  const normalizedEmail = email.trim().toLowerCase();
  const standardResponse = {
    message: 'If the account exists, a password reset link has been sent.',
  };

  const client = await pool.connect();

  try {
    const tableName = getRoleTable(role);
    const idColumn = getRoleIdColumn(role);

    const result = await client.query(
      `SELECT ${idColumn}, full_name, email, is_active
       FROM ${tableName}
       WHERE email = $1`,
      [normalizedEmail]
    );

    if (result.rows.length === 0) {
      return res.status(200).json(standardResponse);
    }

    const user = result.rows[0];

    if (!user.is_active) {
      return res.status(200).json(standardResponse);
    }

    const rawToken = crypto.randomBytes(32).toString('hex');
    const hashedToken = await bcrypt.hash(rawToken, 10);
    const expiryTime = new Date(Date.now() + TOKEN_EXPIRY_MINUTES * 60 * 1000);

    await client.query('BEGIN');

    try {
      await client.query(
        `UPDATE ${tableName}
         SET password_reset_token = NULL,
             password_reset_expires = NULL
         WHERE ${idColumn} = $1`,
        [user[idColumn]]
      );

      await client.query(
        `UPDATE ${tableName}
         SET password_reset_token = $1,
             password_reset_expires = $2
         WHERE ${idColumn} = $3`,
        [hashedToken, expiryTime, user[idColumn]]
      );

      await client.query('COMMIT');

      const resetLink = `${FRONTEND_URL}/reset-password?token=${rawToken}&email=${encodeURIComponent(normalizedEmail)}&role=${role}`;
      
      const transporter = nodemailer.createTransport({
        host: process.env.SMTP_HOST,
        port: Number(process.env.SMTP_PORT),
        secure: false,
        requireTLS: true,
        auth: {
          user: process.env.SMTP_USER,
          pass: process.env.SMTP_PASS
        },
        tls: {
          rejectUnauthorized: false
        }
      });

      await transporter.sendMail({
        from: process.env.FROM_EMAIL,
        to: user.email,
        subject: 'Password Reset Request - VTU Fest',
        html: `
          <h2>Password Reset Request</h2>
          <p>Hi ${user.full_name || 'User'},</p>
          <p>You requested to reset your password. Click the link below to reset it:</p>
          <p><a href="${resetLink}">Reset Password</a></p>
          <p>This link will expire in ${TOKEN_EXPIRY_MINUTES} minutes.</p>
          <p>If you didn't request this, please ignore this email.</p>
          <br>
          <p>VTU Fest Team</p>
        `,
      });

      return res.status(200).json(standardResponse);
    } catch (txError) {
      await client.query('ROLLBACK');
      throw txError;
    }
  } catch (error) {
    console.error('Error in forgot-password:', error);

    return res.status(500).json({
      error: 'An error occurred processing your request',
    });
  } finally {
    client.release();
  }
};