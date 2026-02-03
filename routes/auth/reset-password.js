// routes/auth/reset-password.js
const express = require('express');
const bcrypt = require('bcryptjs');
const pool = require('../../db/pool');

const router = express.Router();

// Match the roles from login.js (frontend format)
const ALLOWED_ROLES = [
  'student',
  'manager',
  'principal',
  'admin',
  'sub_admin',
  'volunteer_registration',
  'volunteer_helpdesk',
  'volunteer_event'
];

const getRoleTable = (role) => {
  if (role === 'student') return 'students';
  return 'users';
};

const getRoleIdColumn = (role) => {
  // Both tables use 'id' as the primary key column
  return 'id';
};

// POST /api/auth/reset-password/:role
router.post('/:role', async (req, res) => {
  // Extract and normalize the role from URL parameter
  const role = req.params.role?.toLowerCase();

  if (!ALLOWED_ROLES.includes(role)) {
    return res.status(400).json({ error: 'Invalid role' });
  }

  const { token, email, new_password } = req.body;

  // Validate token exists (required for both forgot-password and forced reset flows)
  if (!token || typeof token !== 'string' || !token.trim()) {
    return res.status(400).json({ error: 'Reset token is required' });
  }

  if (!email || typeof email !== 'string' || !email.trim()) {
    return res.status(400).json({ error: 'Email is required' });
  }

  if (!new_password || typeof new_password !== 'string' || new_password.length < 8) {
    return res.status(400).json({ error: 'New password must be at least 8 characters' });
  }

  const normalizedEmail = email.trim().toLowerCase();
  const providedToken = token.trim();

  const client = await pool.connect();

  try {
    const tableName = getRoleTable(role);
    const idColumn = getRoleIdColumn(role);

    // Fetch user with force_password_reset flag (for users table only)
    let queryColumns = `${idColumn}, is_active, password_reset_token, password_reset_expires`;
    if (tableName === 'users') {
      queryColumns += ', force_password_reset';
    }

    const result = await client.query(
      `SELECT ${queryColumns}
       FROM ${tableName}
       WHERE email = $1`,
      [normalizedEmail]
    );

    if (result.rows.length === 0) {
      return res.status(400).json({ error: 'Invalid or expired reset token' });
    }

    const user = result.rows[0];

    // Check if account is active
    if (!user.is_active) {
      return res.status(403).json({ error: 'Account is inactive' });
    }

    // Validate token exists in database
    if (!user.password_reset_token || !user.password_reset_expires) {
      return res.status(400).json({ error: 'Invalid or expired reset token' });
    }

    // Check token expiry
    const tokenExpiry = new Date(user.password_reset_expires);
    const now = new Date();

    if (now > tokenExpiry) {
      return res.status(400).json({ error: 'Reset token has expired' });
    }

    // Verify token matches (works for both forgot-password and forced reset)
    const tokenValid = await bcrypt.compare(providedToken, user.password_reset_token);

    if (!tokenValid) {
      return res.status(400).json({ error: 'Invalid or expired reset token' });
    }

    // Hash new password
    const newPasswordHash = await bcrypt.hash(new_password, 10);

    // Begin transaction
    await client.query('BEGIN');

    try {
      // Update password and clear reset token
      let updateQuery = `
        UPDATE ${tableName}
        SET 
          password_hash = $1,
          password_reset_token = NULL,
          password_reset_expires = NULL
      `;

      const params = [newPasswordHash];

      // ⚠️ CRITICAL: Clear force_password_reset flag after successful reset
      if (tableName === 'users' && user.force_password_reset) {
        updateQuery += ', force_password_reset = false';
      }

      updateQuery += ` WHERE ${idColumn} = $2`;
      params.push(user[idColumn]);

      await client.query(updateQuery, params);

      // Commit transaction
      await client.query('COMMIT');

      // Success response (same for both flows)
      return res.status(200).json({
        message: 'Password reset successful. Please login again.',
      });
    } catch (txError) {
      await client.query('ROLLBACK');
      throw txError;
    }
  } catch (error) {
    console.error('Error in reset-password:', error);

    return res.status(500).json({
      error: 'An error occurred processing your request',
    });
  } finally {
    client.release();
  }
});

module.exports = router;