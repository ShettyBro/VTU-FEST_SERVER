/**
 * Standardized Response Utilities
 * Provides consistent response structure across all API endpoints
 */

/**
 * Send success response
 * @param {Object} res - Express response object
 * @param {Object} data - Response data
 * @param {String} message - Success message (optional)
 * @param {Number} statusCode - HTTP status code (default: 200)
 */
const success = (res, data = null, message = 'Success', statusCode = 200) => {
  const response = {
    success: true,
    message,
  };

  if (data !== null) {
    response.data = data;
  }

  return res.status(statusCode).json(response);
};

/**
 * Send error response
 * @param {Object} res - Express response object
 * @param {String} message - Error message
 * @param {Number} statusCode - HTTP status code (default: 500)
 * @param {Object} details - Additional error details (optional)
 */
const error = (res, message, statusCode = 500, details = null) => {
  const response = {
    success: false,
    message,
  };

  // Include details only in development mode or if explicitly provided
  if (details && (process.env.NODE_ENV === 'development' || details.public)) {
    response.details = details;
  }

  return res.status(statusCode).json(response);
};

/**
 * Send validation error response
 * @param {Object} res - Express response object
 * @param {String|Array} errors - Validation error message(s)
 */
const validationError = (res, errors) => {
  return res.status(400).json({
    success: false,
    message: 'Validation error',
    errors: Array.isArray(errors) ? errors : [errors],
  });
};

/**
 * Send unauthorized response (401)
 * Used when token is expired or invalid
 * @param {Object} res - Express response object
 * @param {String} message - Custom message (optional)
 */
const unauthorized = (res, message = 'Token expired. Redirecting to login...') => {
  return res.status(401).json({
    success: false,
    message,
    redirect: 'https://vtufest2026.acharyahabba.com/',
  });
};

/**
 * Send forbidden response (403)
 * Used when user lacks required permissions
 * @param {Object} res - Express response object
 * @param {String} message - Custom message (optional)
 */
const forbidden = (res, message = 'Access denied. Insufficient permissions.') => {
  return res.status(403).json({
    success: false,
    message,
  });
};

/**
 * Send not found response (404)
 * @param {Object} res - Express response object
 * @param {String} resource - Resource name that was not found
 */
const notFound = (res, resource = 'Resource') => {
  return res.status(404).json({
    success: false,
    message: `${resource} not found`,
  });
};

/**
 * Send created response (201)
 * Used after successful resource creation
 * @param {Object} res - Express response object
 * @param {Object} data - Created resource data
 * @param {String} message - Success message (optional)
 */
const created = (res, data, message = 'Resource created successfully') => {
  return res.status(201).json({
    success: true,
    message,
    data,
  });
};

/**
 * Send no content response (204)
 * Used after successful deletion or update with no content to return
 * @param {Object} res - Express response object
 */
const noContent = (res) => {
  return res.status(204).send();
};

/**
 * Send bad request response (400)
 * @param {Object} res - Express response object
 * @param {String} message - Error message
 */
const badRequest = (res, message = 'Bad request') => {
  return res.status(400).json({
    success: false,
    message,
  });
};

/**
 * Send conflict response (409)
 * Used when request conflicts with current state (e.g., duplicate entries)
 * @param {Object} res - Express response object
 * @param {String} message - Conflict message
 */
const conflict = (res, message = 'Resource already exists') => {
  return res.status(409).json({
    success: false,
    message,
  });
};

module.exports = {
  success,
  error,
  validationError,
  unauthorized,
  forbidden,
  notFound,
  created,
  noContent,
  badRequest,
  conflict,
};