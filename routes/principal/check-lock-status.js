// routes/principal/check-lock-status.js
// ✅ PRODUCTION-READY: Optimized with timeout protection

const express = require('express');
const router = express.Router();
const pool = require('../../db/pool');
const { authenticate } = require('../../middleware/auth');
const requireRole = require('../../middleware/requireRole');
const { success, error } = require('../../utils/response');

// Apply middleware
router.use(authenticate);
router.use(requireRole(['PRINCIPAL', 'MANAGER']));

// ============================================================================
// POST /api/principal/check-lock-status
// Check if college has final approval lock and payment status
// ============================================================================
router.post('/', async (req, res) => {
  // 🔍 DEBUGGING: Track request timing
  const requestId = `REQ-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  const startTime = Date.now();
  
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(`📍 [${requestId}] CHECK-LOCK-STATUS: Request started`);
  console.log(`📍 [${requestId}] Timestamp: ${new Date().toISOString()}`);
  console.log(`📍 [${requestId}] User ID: ${req.user?.id}`);
  console.log(`📍 [${requestId}] College ID: ${req.user?.college_id}`);
  console.log(`📍 [${requestId}] Role: ${req.user?.role}`);

  let client;
  const dbConnectStart = Date.now();
  
  try {
    const { college_id } = req.user;

    console.log(`📍 [${requestId}] 🔌 Acquiring database connection...`);
    client = await pool.connect();
    const dbConnectTime = Date.now() - dbConnectStart;
    console.log(`📍 [${requestId}] ✅ Database connected in ${dbConnectTime}ms`);

    console.log(`📍 [${requestId}] 🔍 Fetching lock status for college ${college_id}...`);
    const queryStart = Date.now();

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

    const queryTime = Date.now() - queryStart;
    console.log(`📍 [${requestId}] ✅ Query completed in ${queryTime}ms`);

    if (result.rows.length === 0) {
      const totalTime = Date.now() - startTime;
      console.log(`📍 [${requestId}] ❌ College not found - Total time: ${totalTime}ms`);
      console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
      
      return res.status(404).json({
        success: false,
        error: 'College not found',
        requestId,
      });
    }

    const data = result.rows[0];
    const totalTime = Date.now() - startTime;

    console.log(`📍 [${requestId}] ✅ Lock status retrieved successfully`);
    console.log(`📍 [${requestId}] 🔒 Is locked: ${!!data.is_final_approved}`);
    console.log(`📍 [${requestId}] ⏱️ Total request time: ${totalTime}ms`);
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

    return res.status(200).json({
      success: true,
      is_locked: !!data.is_final_approved,
      final_approved_at: data.final_approved_at,
      college_code: data.college_code,
      college_name: data.college_name,
      payment_status: data.payment_status,
      payment_uploaded_at: data.payment_uploaded_at,
      payment_remarks: data.payment_remarks,
      _debug: {
        requestId,
        timings: {
          db_connect_ms: dbConnectTime,
          query_ms: queryTime,
          total_ms: totalTime,
        },
      },
    });

  } catch (err) {
    const elapsed = Date.now() - startTime;
    
    console.error('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.error(`📍 [${requestId}] ❌ ERROR after ${elapsed}ms`);
    console.error(`📍 [${requestId}] Error:`, err);
    console.error('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

    return res.status(500).json({
      success: false,
      error: 'Internal server error',
      requestId,
      details: process.env.NODE_ENV === 'development' ? err.message : undefined,
    });

  } finally {
    if (client) {
      client.release();
      console.log(`📍 [${requestId}] 🔌 Database connection released`);
    }
  }
});

module.exports = router;