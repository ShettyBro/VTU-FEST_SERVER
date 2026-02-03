const { Pool } = require('pg');
require('dotenv').config();

// Neon PostgreSQL connection pool configuration
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { 
    rejectUnauthorized: false 
  }, // Required for Neon
  max: 20,
  min: 2,
  idleTimeoutMillis: 30000,
});

// Handle unexpected database errors
pool.on('error', (err) => {
  console.error('Unexpected database error:', err);
  process.exit(-1);
});

// Log successful connection (optional, for debugging)
pool.on('connect', () => {
  console.log('Connected to Neon PostgreSQL database');
});

module.exports = pool;