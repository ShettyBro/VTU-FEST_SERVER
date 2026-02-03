const jwt = require('jsonwebtoken');
const pool = require('../db/pool');

const JWT_SECRET = process.env.JWT_SECRET;

/**
 * JWT Authentication Middleware
 * Verifies token and loads user identity from database
 * Supports both STUDENT role (students table) and other roles (users table)
 */
const authenticate = async (req, res, next) => {
  try {
    // Extract token from Authorization header
    const authHeader = req.headers.authorization;

    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({
        success: false,
        message: 'No token provided. Redirecting to login...',
        redirect: 'https://vtufest2026.acharyahabba.com/',
      });
    }

    const token = authHeader.substring(7); // Remove 'Bearer ' prefix

    // Verify and decode token
    let decoded;
    try {
      decoded = jwt.verify(token, JWT_SECRET);
    } catch (err) {
      if (err.name === 'TokenExpiredError') {
        return res.status(401).json({
          success: false,
          message: 'Token expired. Redirecting to login...',
          redirect: 'https://vtufest2026.acharyahabba.com/',
        });
      }
      return res.status(401).json({
        success: false,
        message: 'Invalid token. Redirecting to login...',
        redirect: 'https://vtufest2026.acharyahabba.com/',
      });
    }

    // Load user identity based on role
    if (decoded.role === 'STUDENT') {
      // ✅ FIXED: Query students table with correct column names
      const result = await pool.query(
        `SELECT 
          id,              -- ✅ FIXED: id (not student_id)
          usn, 
          full_name, 
          email, 
          phone, 
          college_id, 
          is_active 
        FROM students 
        WHERE id = $1`,    // ✅ FIXED: id (not student_id)
        [decoded.student_id]
      );

      if (result.rows.length === 0) {
        return res.status(401).json({
          success: false,
          message: 'Student account not found. Redirecting to login...',
          redirect: 'https://vtufest2026.acharyahabba.com/',
        });
      }

      const student = result.rows[0];

      // Check if account is active
      if (!student.is_active) {
        return res.status(403).json({
          success: false,
          message: 'Account is inactive. Please contact support.',
        });
      }

      // ✅ FIXED: Attach user info with both id and student_id for compatibility
      req.user = {
        id: student.id,              // ✅ FIXED: student.id
        student_id: student.id,      // ✅ ADDED: For backward compatibility
        usn: student.usn,
        role: 'STUDENT',
        college_id: student.college_id,
        full_name: student.full_name,
        email: student.email,
        phone: student.phone,
      };

    } else {
      // ✅ FIXED: Query users table with correct column names
      const result = await pool.query(
        `SELECT 
          id,          -- ✅ FIXED: id (not user_id)
          full_name, 
          email, 
          phone, 
          role, 
          college_id, 
          is_active 
        FROM users 
        WHERE id = $1 AND role = $2`,  // ✅ FIXED: id (not user_id)
        [decoded.user_id, decoded.role]
      );

      if (result.rows.length === 0) {
        return res.status(401).json({
          success: false,
          message: 'User account not found. Redirecting to login...',
          redirect: 'https://vtufest2026.acharyahabba.com/',
        });
      }

      const user = result.rows[0];

      // Check if account is active
      if (!user.is_active) {
        return res.status(403).json({
          success: false,
          message: 'Account is inactive. Please contact support.',
        });
      }

      // ✅ FIXED: Attach user info with correct id reference
      req.user = {
        id: user.id,         // ✅ FIXED: user.id (not user.user_id)
        role: user.role,
        college_id: user.college_id,
        full_name: user.full_name,
        email: user.email,
        phone: user.phone,
      };
    }

    // Continue to next middleware/route handler
    next();

  } catch (err) {
    console.error('Authentication error:', err);
    return res.status(500).json({
      success: false,
      message: 'Authentication failed. Please try again.',
    });
  }
};

/**
 * Role-based authorization middleware
 * Use after authenticate middleware
 * @param {string[]} allowedRoles - Array of allowed roles
 */
const authorize = (...allowedRoles) => {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({
        success: false,
        message: 'Unauthorized. Please login.',
      });
    }

    if (!allowedRoles.includes(req.user.role)) {
      return res.status(403).json({
        success: false,
        message: 'Access denied. Insufficient permissions.',
      });
    }

    next();
  };
};

module.exports = {
  authenticate,
  authorize,
};