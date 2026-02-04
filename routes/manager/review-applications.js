// routes/manager/review-applications.js
// ✅ PRODUCTION-READY: Router pattern with full debugging & optimization

const express = require('express');
const router = express.Router();
const pool = require('../../db/pool');
const { authenticate } = require('../../middleware/auth');
const requireRole = require('../../middleware/requireRole');

// Apply middleware
router.use(authenticate);
router.use(requireRole(['MANAGER']));

// ============================================================================
// POST /api/manager/review-applications
// Multi-action endpoint for application review management
// ============================================================================
router.post('/', async (req, res) => {
  // 🔍 DEBUGGING: Track request timing
  const requestId = `REQ-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  const startTime = Date.now();
  
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(`📍 [${requestId}] REVIEW-APPLICATIONS: Request started`);
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
        message: 'Request timeout. The operation took too long. Please contact support if this persists.',
        requestId,
        elapsed_ms: elapsed,
      });
    }
  }, 9000); // 9 seconds (before Railway's 10s limit)

  try {
    const user_id = req.user.id;
    const college_id = req.user.college_id;
    const role = req.user.role;
    const { action } = req.body;

    console.log(`📍 [${requestId}] Action requested: "${action}"`);

    if (!user_id || !college_id || role !== 'MANAGER') {
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

      // ========================================================================
      // ACTION: LIST APPLICATIONS
      // ========================================================================
      if (action === 'list') {
        console.log(`📍 [${requestId}] 🔍 Fetching applications for college ${college_id}...`);
        
        const queryStart = Date.now();
        
        // ✅ OPTIMIZED QUERY: Single JOIN instead of N+1 queries
        const result = await client.query(
          `SELECT 
             sa.id AS application_id,
             sa.student_id,
             sa.status,
             sa.rejected_reason,
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
           WHERE s.college_id = $1 AND s.is_active = true
           ORDER BY sa.submitted_at DESC, sa.id, ad.id
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
              rejected_reason: row.rejected_reason,
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
      }

      // ========================================================================
      // ACTION: APPROVE APPLICATION
      // ========================================================================
      if (action === 'approve') {
        console.log(`📍 [${requestId}] ✅ Approve action requested`);
        
        const { application_id } = req.body;

        if (!application_id) {
          clearTimeout(requestTimeout);
          return res.status(400).json({
            success: false,
            message: 'application_id is required',
            requestId,
          });
        }

        const lockResult = await client.query(
          `SELECT is_final_approved FROM colleges WHERE id = $1`,
          [college_id]
        );

        if (lockResult.rows.length === 0) {
          clearTimeout(requestTimeout);
          return res.status(400).json({
            success: false,
            message: 'Invalid college',
            requestId,
          });
        }

        if (lockResult.rows[0].is_final_approved === true) {
          clearTimeout(requestTimeout);
          return res.status(403).json({
            success: false,
            message: 'Final approval is locked. Cannot approve applications.',
            requestId,
          });
        }

        const appResult = await client.query(
          `SELECT sa.id, sa.status, s.college_id
           FROM student_applications sa
           INNER JOIN students s ON sa.student_id = s.id
           WHERE sa.id = $1`,
          [application_id]
        );

        if (appResult.rows.length === 0) {
          clearTimeout(requestTimeout);
          return res.status(404).json({
            success: false,
            message: 'Application not found',
            requestId,
          });
        }

        const application = appResult.rows[0];

        if (application.college_id !== college_id) {
          clearTimeout(requestTimeout);
          return res.status(403).json({
            success: false,
            message: 'Unauthorized',
            requestId,
          });
        }

        if (application.status !== 'PENDING') {
          clearTimeout(requestTimeout);
          return res.status(400).json({
            success: false,
            message: 'Only PENDING applications can be approved',
            requestId,
          });
        }

        await client.query(
          `UPDATE student_applications
           SET status = 'APPROVED', reviewed_at = NOW()
           WHERE id = $1`,
          [application_id]
        );

        const totalTime = Date.now() - startTime;
        console.log(`📍 [${requestId}] ✅ Application approved in ${totalTime}ms`);

        clearTimeout(requestTimeout);

        return res.status(200).json({
          success: false,
          message: 'Application approved successfully',
          requestId,
        });
      }

      // ========================================================================
      // ACTION: REJECT APPLICATION
      // ========================================================================
      if (action === 'reject') {
        console.log(`📍 [${requestId}] ❌ Reject action requested`);
        
        const { application_id, rejected_reason } = req.body;

        if (!application_id) {
          clearTimeout(requestTimeout);
          return res.status(400).json({
            success: false,
            message: 'application_id is required',
            requestId,
          });
        }

        const lockResult = await client.query(
          `SELECT is_final_approved FROM colleges WHERE id = $1`,
          [college_id]
        );

        if (lockResult.rows.length === 0) {
          clearTimeout(requestTimeout);
          return res.status(400).json({
            success: false,
            message: 'Invalid college',
            requestId,
          });
        }

        if (lockResult.rows[0].is_final_approved === true) {
          clearTimeout(requestTimeout);
          return res.status(403).json({
            success: false,
            message: 'Final approval is locked. Cannot reject applications.',
            requestId,
          });
        }

        const appResult = await client.query(
          `SELECT sa.id, sa.status, s.college_id
           FROM student_applications sa
           INNER JOIN students s ON sa.student_id = s.id
           WHERE sa.id = $1`,
          [application_id]
        );

        if (appResult.rows.length === 0) {
          clearTimeout(requestTimeout);
          return res.status(404).json({
            success: false,
            message: 'Application not found',
            requestId,
          });
        }

        const application = appResult.rows[0];

        if (application.college_id !== college_id) {
          clearTimeout(requestTimeout);
          return res.status(403).json({
            success: false,
            message: 'Unauthorized',
            requestId,
          });
        }

        if (application.status !== 'PENDING') {
          clearTimeout(requestTimeout);
          return res.status(400).json({
            success: false,
            message: 'Only PENDING applications can be rejected',
            requestId,
          });
        }

        await client.query(
          `UPDATE student_applications
           SET status = 'REJECTED', rejected_reason = $1, reviewed_at = NOW()
           WHERE id = $2`,
          [rejected_reason || null, application_id]
        );

        const totalTime = Date.now() - startTime;
        console.log(`📍 [${requestId}] ✅ Application rejected in ${totalTime}ms`);

        clearTimeout(requestTimeout);

        return res.status(200).json({
          success: true,
          message: 'Application rejected successfully',
          requestId,
        });
      }

      // Invalid action
      clearTimeout(requestTimeout);
      return res.status(400).json({
        success: false,
        message: 'Invalid action',
        requestId,
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