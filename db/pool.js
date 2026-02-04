const { Pool } = require('pg');
require('dotenv').config();

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { 
    rejectUnauthorized: false 
  },
  max: 20,
  min: 2,
  idleTimeoutMillis: 30000,
  // Add these two lines:
  keepAlive: true, 
  connectionTimeoutMillis: 5000, 
});

// Handle unexpected database errors without crashing
pool.on('error', (err) => {
  // Log the error so you can see it, but DON'T exit the process
  console.error('⚠️ Unexpected database error on idle client:', err.message);
});

pool.on('connect', () => {
  console.log('✓ New client connected to Neon pool');
});

module.exports = pool;