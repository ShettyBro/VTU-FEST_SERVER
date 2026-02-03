const express = require('express');
const cors = require('cors');


// Initialize Express app
const app = express();

// ============================================================================
// MIDDLEWARE
// ============================================================================

// CORS configuration
app.use(cors({
  origin: '*', // Configure this for production
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
}));

// Body parser middleware
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Request logging middleware (optional, for debugging)
app.use((req, res, next) => {
  console.log(`${new Date().toISOString()} - ${req.method} ${req.path}`);
  next();
});

// ============================================================================
// IMPORT ROUTES
// ============================================================================

// Auth routes
const loginRoute = require('../routes/auth/login');
const forgotPasswordRoute = require('../routes/auth/forgot-password');
const resetPasswordRoute = require('../routes/auth/reset-password');

// Student routes
const registerRoute = require('../routes/student/register');
const studentDashboardRoute = require('../routes/student/dashboard');
const submitApplicationRoute = require('../routes/student/submit-application');
const studentPaymentRoute = require('../routes/student/payment');

// Manager routes
const managerDashboardRoute = require('../routes/manager/dashboard');
const manageAccompanistsRoute = require('../routes/manager/manage-accompanists');
const assignEventsRoute = require('../routes/manager/assign-events');
const reviewApplicationsRoute = require('../routes/manager/review-applications');
const approvedStudentsRoute = require('../routes/manager/approved-students');
const accommodationRoute = require('../routes/manager/accommodation');
const rejectedStudentsRoute = require('../routes/manager/rejected-students');
const managerProfileRoute = require('../routes/manager/manager-profile');

// Principal routes
const finalApprovalRoute = require('../routes/principal/final-approval');
const pendingFinalApprovalRoute = require('../routes/principal/pending-final-approval');
const checkLockStatusRoute = require('../routes/principal/check-lock-status');
const assignManagerRoute = require('../routes/principal/assign-manager');

// Admin routes
const pendingPaymentsRoute = require('../routes/admin/pending-payments');
const verifyPaymentRoute = require('../routes/admin/verify-payment');

// Shared routes
const collegeAndUSNRoute = require('../routes/shared/college-and-usn');

// ============================================================================
// MOUNT ROUTES
// ============================================================================

// Health check endpoint
app.get('/health', (req, res) => {
  res.status(200).json({
    success: true,
    message: 'VTU FEST 2026 API is running',
    timestamp: new Date().toISOString(),
  });
});

// Auth routes
app.use('/api/auth/login', loginRoute);
app.use('/api/auth/forgot-password', forgotPasswordRoute);
// ✅ FIXED: Changed to mount the router at base path so /:role parameter works
app.use('/api/auth/reset-password', resetPasswordRoute);

// Student routes
app.use('/api/student/register', registerRoute);
app.use('/api/student/dashboard', studentDashboardRoute);
app.use('/api/student/submit-application', submitApplicationRoute);
app.use('/api/student/payment', studentPaymentRoute);

// Manager routes
app.use('/api/manager/dashboard', managerDashboardRoute);
app.use('/api/manager/manage-accompanists', manageAccompanistsRoute);
app.use('/api/manager/assign-events', assignEventsRoute);
app.use('/api/manager/review-applications', reviewApplicationsRoute);
app.use('/api/manager/approved-students', approvedStudentsRoute);
app.use('/api/manager/accommodation', accommodationRoute);
app.use('/api/manager/rejected-students', rejectedStudentsRoute);
app.use('/api/manager/manager-profile', managerProfileRoute);

// Principal routes
app.use('/api/principal/final-approval', finalApprovalRoute);
app.use('/api/principal/pending-final-approval', pendingFinalApprovalRoute);
app.use('/api/principal/check-lock-status', checkLockStatusRoute);
app.use('/api/principal/assign-manager', assignManagerRoute);

// Admin routes
app.use('/api/admin/pending-payments', pendingPaymentsRoute);
app.use('/api/admin/verify-payment', verifyPaymentRoute);

// Shared routes
app.use('/api/shared/college-and-usn', collegeAndUSNRoute);

// ============================================================================
// ERROR HANDLING
// ============================================================================

// 404 handler - Unknown routes
app.use((req, res) => {
  res.status(404).json({
    success: false,
    message: 'Route not found',
    path: req.path,
  });
});

// Global error handler
app.use((err, req, res, next) => {
  console.error('Global error handler:', err);

  // Handle specific error types
  if (err.name === 'ValidationError') {
    return res.status(400).json({
      success: false,
      message: 'Validation error',
      errors: err.message,
    });
  }

  if (err.name === 'UnauthorizedError') {
    return res.status(401).json({
      success: false,
      message: 'Unauthorized access',
    });
  }

  // Database errors
  if (err.code && err.code.startsWith('23')) { // PostgreSQL constraint violations
    return res.status(400).json({
      success: false,
      message: 'Database constraint violation',
      error: process.env.NODE_ENV === 'development' ? err.message : undefined,
    });
  }

  // Generic server error
  res.status(err.status || 500).json({
    success: false,
    message: err.message || 'Internal server error',
    error: process.env.NODE_ENV === 'development' ? err.stack : undefined,
  });
});

// Export app without starting the server
module.exports = app;