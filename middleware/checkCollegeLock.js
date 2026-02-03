const pool = require('../db/pool');

/**
 * College Lock Status Verification Middleware
 * Checks if college final approval is locked (is_final_approved = true)
 * Prevents modifications after final approval
 * 
 * Usage: Place after auth middleware on routes that modify college data
 * 
 * @example
 * router.post('/api/student/apply', auth, checkCollegeLock, handler);
 * router.post('/api/manager/update-student', auth, requireRole(['MANAGER']), checkCollegeLock, handler);
 */
const checkCollegeLock = async (req, res, next) => {
  try {
    // Check if user object exists (should be set by auth middleware)
    if (!req.user) {
      return res.status(401).json({
        success: false,
        message: 'Authentication required',
      });
    }

    // Skip lock check for ADMIN role (they have no college_id and can override locks)
    if (req.user.role === 'ADMIN' || req.user.role === 'SUB_ADMIN') {
      return next();
    }

    // Check if user has a college_id
    if (!req.user.college_id) {
      return res.status(400).json({
        success: false,
        message: 'College ID not found in user profile',
      });
    }

    // Query college lock status
    const result = await pool.query(
      'SELECT is_final_approved FROM colleges WHERE id = $1',
      [req.user.college_id]
    );

    // Handle case where college is not found
    if (result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'College not found',
      });
    }

    const college = result.rows[0];

    // Check if college is locked
    if (college.is_final_approved === true) {
      return res.status(403).json({
        success: false,
        message: 'Final approval is locked. No modifications allowed.',
      });
    }

    // College is not locked, allow the request to proceed
    next();

  } catch (error) {
    console.error('College lock check error:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to verify college lock status',
    });
  }
};

module.exports = checkCollegeLock;