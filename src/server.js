require('dotenv').config();
const app = require('./app');
const pool = require('../db/pool');

// Server configuration
const PORT = process.env.PORT || 3000;
const NODE_ENV = process.env.NODE_ENV || 'development';

// Server instance (for graceful shutdown)
let server;

// ============================================================================
// DATABASE CONNECTION TEST
// ============================================================================
const testDatabaseConnection = async () => {
  try {
    // Test database connection with a simple query
    const result = await pool.query('SELECT NOW() as current_time');
    console.log('✓ Database connected successfully');
    console.log(`  Current database time: ${result.rows[0].current_time}`);
    return true;
  } catch (error) {
    console.error('✗ Database connection failed:', error.message);
    throw error;
  }
};

// ============================================================================
// START SERVER
// ============================================================================
const startServer = async () => {
  try {
    // Test database connection before starting server
    await testDatabaseConnection();

    // Start Express server
    server = app.listen(PORT, () => {
      console.log('');
      console.log('='.repeat(60));
      console.log('  VTU FEST 2026 Registration System');
      console.log('='.repeat(60));
      console.log(`  Environment: ${NODE_ENV}`);
      console.log(`  Server running on port ${PORT}`);
      console.log(`  API Base URL: http://localhost:${PORT}/api`);
      console.log(`  Health Check: http://localhost:${PORT}/health`);
      console.log('='.repeat(60));
      console.log('');
    });

  } catch (error) {
    console.error('Failed to start server:', error);
    process.exit(1);
  }
};

// ============================================================================
// GRACEFUL SHUTDOWN
// ============================================================================
const gracefulShutdown = async (signal) => {
  console.log(`\n${signal} received. Starting graceful shutdown...`);

  // Close server to stop accepting new connections
  if (server) {
    server.close(async () => {
      console.log('✓ Express server closed');

      // Close database connection pool
      try {
        await pool.end();
        console.log('✓ Database connection pool closed');
        console.log('Shutdown complete. Goodbye!');
        process.exit(0);
      } catch (error) {
        console.error('Error closing database pool:', error);
        process.exit(1);
      }
    });

    // Force shutdown after 10 seconds if graceful shutdown fails
    setTimeout(() => {
      console.error('Forced shutdown after timeout');
      process.exit(1);
    }, 10000);
  } else {
    // No server running, just close pool
    try {
      await pool.end();
      console.log('✓ Database connection pool closed');
      process.exit(0);
    } catch (error) {
      console.error('Error closing database pool:', error);
      process.exit(1);
    }
  }
};

// ============================================================================
// SIGNAL HANDLERS
// ============================================================================

// Handle SIGTERM (e.g., from Railway, Heroku, Docker)
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));

// Handle SIGINT (Ctrl+C in terminal)
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

// Handle uncaught exceptions
process.on('uncaughtException', (error) => {
  console.error('Uncaught Exception:', error);
  gracefulShutdown('uncaughtException');
});

// Handle unhandled promise rejections
process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
  gracefulShutdown('unhandledRejection');
});

// ============================================================================
// START APPLICATION
// ============================================================================
startServer();