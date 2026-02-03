/**
 * Role-Based Access Control Middleware
 * Factory function that returns middleware checking for allowed roles
 * 
 * @param {string[]} allowedRoles - Array of allowed role strings
 * @returns {Function} Express middleware function
 * 
 * @example
 * // Single role
 * router.post('/api/student/profile', auth, requireRole(['STUDENT']), handler);
 * 
 * @example
 * // Multiple roles
 * router.post('/api/manager/dashboard', auth, requireRole(['MANAGER', 'PRINCIPAL']), handler);
 */
const requireRole = (allowedRoles) => {
  // Validate input
  if (!Array.isArray(allowedRoles) || allowedRoles.length === 0) {
    throw new Error('requireRole: allowedRoles must be a non-empty array');
  }

  // Return the actual middleware function
  return (req, res, next) => {
    try {
      // Check if user object exists (should be set by auth middleware)
      if (!req.user) {
        return res.status(401).json({
          success: false,
          message: 'Authentication required',
        });
      }

      // Check if user has a role
      if (!req.user.role) {
        return res.status(403).json({
          success: false,
          message: 'User role not found',
        });
      }

      // Check if user's role is in the allowed roles array
      if (!allowedRoles.includes(req.user.role)) {
        return res.status(403).json({
          success: false,
          message: 'Unauthorized: Required role not found',
        });
      }

      // User has required role, continue to next middleware/handler
      next();
    } catch (error) {
      console.error('Role check error:', error);
      return res.status(500).json({
        success: false,
        message: 'Authorization check failed',
      });
    }
  };
};

module.exports = requireRole;