const express = require('express');
const router = express.Router();
const jwt = require('jsonwebtoken');
const pool = require('../../db/pool'); // PostgreSQL connection pool

const JWT_SECRET = process.env.JWT_SECRET;

// ============================================================================
// MIDDLEWARE: Verify JWT and Principal/Manager Role
// ============================================================================
const requireRole = (allowedRoles) => {
  return (req, res, next) => {
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

      if (!allowedRoles.includes(decoded.role)) {
        return res.status(403).json({
          success: false,
          error: 'Unauthorized: Principal or Manager role required',
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
};

// ============================================================================
// ROUTE: POST /api/principal/check-lock-status
// ============================================================================
router.post('/check-lock-status', requireRole(['PRINCIPAL', 'MANAGER']), async (req, res) => {
  const client = await pool.connect();
  
  try {
    const { college_id } = req.auth;

    // Get college lock status and payment status
    const result = await client.query(
      `SELECT 
        c.is_final_approved,
        c.final_approved_at,
        c.college_code,
        c.college_name,
        pr.status AS payment_status,
        pr.uploaded_at AS payment_uploaded_at,
        pr.admin_remarks AS payment_remarks
       FROM colleges c
       LEFT JOIN payment_receipts pr ON c.id = pr.college_id
       WHERE c.id = $1`,
      [college_id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        error: 'College not found',
      });
    }

    const data = result.rows[0];

    return res.status(200).json({
      success: true,
      is_locked: !!data.is_final_approved,
      final_approved_at: data.final_approved_at,
      college_code: data.college_code,
      college_name: data.college_name,
      payment_status: data.payment_status,
      payment_uploaded_at: data.payment_uploaded_at,
      payment_remarks: data.payment_remarks,
    });
  } catch (error) {
    console.error('check-lock-status error:', error);
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