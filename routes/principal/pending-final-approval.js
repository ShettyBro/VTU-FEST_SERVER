// routes/principal/pending-final-approval.js
// ✅ PRODUCTION-READY: Optimized with single JOIN query to prevent N+1 issue

const express = require('express');
const router = express.Router();
const pool = require('../../db/pool');
const { authenticate } = require('../../middleware/auth');
const requireRole = require('../../middleware/requireRole');
const { success, error } = require('../../utils/response');

// Apply middleware
router.use(authenticate);
router.use(requireRole(['PRINCIPAL']));

// ============================================================================
// POST /api/principal/pending-final-approval
// Get all approved students pending final approval with their documents
// ============================================================================
router.post('/', async (req, res) => {
  // 🔍 DEBUGGING: Track request timing
  const requestId = `REQ-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  const startTime = Date.now();
  
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(`📍 [${requestId}] PENDING-FINAL-APPROVAL: Request started`);
  console.log(`📍 [${requestId}] Timestamp: ${new Date().toISOString()}`);
  console.log(`📍 [${requestId}] User ID: ${req.user?.id}`);
  console.log(`📍 [${requestId}] College ID: ${req.user?.college_id}`);
  console.log(`📍 [${requestId}] Role: ${req.user?.role}`);
  
  // ⏱️ TIMEOUT PROTECTION: Respond before Railway's 10s timeout
  let timeoutOccurred = false;
  const requestTimeout = setTimeout(() => {
    timeoutOccurred = true;
    const elapsed = Date.now() - startTime;
    console.error(`📍 [${requestId}] ⏱️ TIMEOUT after ${elapsed}ms`);
    
    if (!res.headersSent) {
      res.status(504).json({
        success: false,
        message: 'Request timeout. Please contact support if this persists.',
        requestId,
        elapsed_ms: elapsed,
      });
    }
  }, 9000); // 9 seconds (before Railway's 10s limit)

  try {
    const user_id = req.user.id;
    const college_id = req.user.college_id;
    const role = req.user.role;

    if (!user_id || !college_id || role !== 'PRINCIPAL') {
      clearTimeout(requestTimeout);
      console.warn(`📍 [${requestId}] ❌ Authorization failed`);
      return res.status(403).json({
        success: false,
        message: 'Unauthorized',
        requestId,
      });
    }

    let client;
    const dbConnectStart = Date.now();
    
    try {
      console.log(`📍 [${requestId}] 🔌 Acquiring database connection...`);
      client = await pool.connect();
      const dbConnectTime = Date.now() - dbConnectStart;
      console.log(`📍 [${requestId}] ✅ Database connected in ${dbConnectTime}ms`);

      console.log(`📍 [${requestId}] 🔍 Fetching approved applications for college ${college_id}...`);
      
      const queryStart = Date.now();
      
      // ✅ OPTIMIZED QUERY: Single JOIN instead of N+1 queries
      const result = await client.query(
        `SELECT 
           sa.id AS application_id,
           sa.student_id,
           sa.status,
           sa.submitted_at,
           sa.reviewed_at,
           s.usn,
           s.full_name,
           s.email,
           s.phone,
           s.gender,
           s.passport_photo_url,
           ad.document_type,
           ad.document_url
         FROM student_applications sa
         INNER JOIN students s ON sa.student_id = s.id
         LEFT JOIN application_documents ad ON sa.id = ad.application_id
         WHERE s.college_id = $1
           AND sa.status = 'APPROVED'
         ORDER BY sa.reviewed_at DESC, sa.id, ad.id
         LIMIT 10000`,
        [college_id]
      );

      const queryTime = Date.now() - queryStart;
      console.log(`📍 [${requestId}] ✅ Query completed in ${queryTime}ms`);
      console.log(`📍 [${requestId}] 📊 Rows returned: ${result.rows.length}`);

      // ========================================================================
      // PROCESS RESULTS: Group documents by application
      // ========================================================================
      const processingStart = Date.now();
      const applicationsMap = new Map();

      for (const row of result.rows) {
        const appId = row.application_id;

        if (!applicationsMap.has(appId)) {
          applicationsMap.set(appId, {
            application_id: appId,
            student_id: row.student_id,
            usn: row.usn,
            full_name: row.full_name,
            email: row.email,
            phone: row.phone,
            gender: row.gender,
            passport_photo_url: row.passport_photo_url,
            status: row.status,
            submitted_at: row.submitted_at,
            reviewed_at: row.reviewed_at,
            documents: [],
          });
        }

        if (row.document_type && row.document_url) {
          applicationsMap.get(appId).documents.push({
            document_type: row.document_type,
            document_url: row.document_url,
          });
        }
      }

      const applications = Array.from(applicationsMap.values());
      const processingTime = Date.now() - processingStart;
      const totalTime = Date.now() - startTime;

      console.log(`📍 [${requestId}] ✅ Processing completed in ${processingTime}ms`);
      console.log(`📍 [${requestId}] 📦 Applications processed: ${applications.length}`);
      console.log(`📍 [${requestId}] ⏱️ Total request time: ${totalTime}ms`);
      console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

      clearTimeout(requestTimeout);

      return res.status(200).json({
        success: true,
        applications,
        _debug: {
          requestId,
          timings: {
            db_connect_ms: dbConnectTime,
            query_ms: queryTime,
            processing_ms: processingTime,
            total_ms: totalTime,
          },
          counts: {
            applications: applications.length,
            total_rows: result.rows.length,
          },
        },
      });

    } catch (dbError) {
      clearTimeout(requestTimeout);
      const elapsed = Date.now() - startTime;
      
      console.error('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
      console.error(`📍 [${requestId}] ❌ DATABASE ERROR after ${elapsed}ms`);
      console.error(`📍 [${requestId}] Error:`, dbError);
      console.error('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

      if (!res.headersSent) {
        return res.status(500).json({
          success: false,
          message: 'Database error occurred. Please try again.',
          requestId,
          error: process.env.NODE_ENV === 'development' ? dbError.message : undefined,
        });
      }

    } finally {
      if (client) {
        client.release();
        console.log(`📍 [${requestId}] 🔌 Database connection released`);
      }
    }

  } catch (error) {
    clearTimeout(requestTimeout);
    const elapsed = Date.now() - startTime;
    
    console.error('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.error(`📍 [${requestId}] ❌ FATAL ERROR after ${elapsed}ms`);
    console.error(`📍 [${requestId}] Error:`, error);
    console.error('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

    if (!res.headersSent) {
      return res.status(500).json({
        success: false,
        message: 'An error occurred processing your request',
        requestId,
        error: process.env.NODE_ENV === 'development' ? error.message : undefined,
      });
    }
  }
});

module.exports = router;