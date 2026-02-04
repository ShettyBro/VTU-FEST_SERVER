// routes/manager/review-applications.js
// ============================================================================
// 🚀 PRODUCTION-READY VERSION WITH COMPREHENSIVE DEBUGGING
// ============================================================================
// Author: AI Assistant
// Date: 2026-02-04
// Purpose: Handle review, approve, and reject student applications
// Optimizations: 
//   - Single JOIN query (no N+1 problem)
//   - Timeout protection (9s before Railway's 10s limit)
//   - Comprehensive error logging
//   - Performance monitoring
// ============================================================================

const pool = require('../../db/pool');

module.exports = async (req, res) => {
  // ============================================================================
  // 📊 STEP 1: INITIALIZE REQUEST TRACKING
  // ============================================================================
  const requestId = `REQ-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  const startTime = Date.now();
  const timings = {};
  
  console.log('\n' + '='.repeat(80));
  console.log(`🚀 [${requestId}] REVIEW-APPLICATIONS REQUEST STARTED`);
  console.log('='.repeat(80));
  console.log(`📅 Timestamp: ${new Date().toISOString()}`);
  console.log(`👤 User ID: ${req.user?.id || 'UNKNOWN'}`);
  console.log(`🏛️  College ID: ${req.user?.college_id || 'UNKNOWN'}`);
  console.log(`🎭 Role: ${req.user?.role || 'UNKNOWN'}`);
  console.log(`📨 Action: ${req.body?.action || 'UNKNOWN'}`);
  console.log('='.repeat(80) + '\n');

  // ============================================================================
  // ⏱️ STEP 2: TIMEOUT PROTECTION MECHANISM
  // ============================================================================
  // Railway proxy times out after 10 seconds with 502 error
  // We set our timeout to 9 seconds to respond before Railway kills the connection
  let timeoutOccurred = false;
  const requestTimeout = setTimeout(() => {
    timeoutOccurred = true;
    const elapsed = Date.now() - startTime;
    
    console.error('\n' + '⚠'.repeat(80));
    console.error(`⏱️  [${requestId}] TIMEOUT TRIGGERED AT ${elapsed}ms`);
    console.error('⚠'.repeat(80));
    console.error(`🔍 Debug Info:`);
    console.error(`   - Request started at: ${new Date(startTime).toISOString()}`);
    console.error(`   - Current time: ${new Date().toISOString()}`);
    console.error(`   - Elapsed: ${elapsed}ms`);
    console.error(`   - Timings so far:`, JSON.stringify(timings, null, 2));
    console.error('⚠'.repeat(80) + '\n');
    
    if (!res.headersSent) {
      res.status(504).json({
        success: false,
        message: 'Request timeout. The operation took longer than expected. Please try again or contact support.',
        requestId,
        debug: {
          elapsed_ms: elapsed,
          timeout_threshold_ms: 9000,
          timings,
        },
      });
    }
  }, 9000); // 9 seconds timeout

  try {
    // ============================================================================
    // 🔐 STEP 3: AUTHORIZATION VALIDATION
    // ============================================================================
    const authStart = Date.now();
    console.log(`🔐 [${requestId}] Step 3: Validating authorization...`);
    
    const user_id = req.user?.id;
    const college_id = req.user?.college_id;
    const role = req.user?.role;

    if (!user_id || !college_id || role !== 'MANAGER') {
      clearTimeout(requestTimeout);
      timings.authorization_ms = Date.now() - authStart;
      
      console.error(`❌ [${requestId}] Authorization failed:`);
      console.error(`   - User ID: ${user_id || 'MISSING'}`);
      console.error(`   - College ID: ${college_id || 'MISSING'}`);
      console.error(`   - Role: ${role || 'MISSING'}`);
      console.error(`   - Expected Role: MANAGER\n`);
      
      return res.status(403).json({
        success: false,
        message: 'Unauthorized',
        requestId,
      });
    }

    timings.authorization_ms = Date.now() - authStart;
    console.log(`✅ [${requestId}] Authorization passed in ${timings.authorization_ms}ms\n`);

    const { action } = req.body;

    // ============================================================================
    // 🔌 STEP 4: DATABASE CONNECTION ACQUISITION
    // ============================================================================
    const dbConnectStart = Date.now();
    console.log(`🔌 [${requestId}] Step 4: Acquiring database connection...`);
    
    let client;
    try {
      client = await pool.connect();
      timings.db_connect_ms = Date.now() - dbConnectStart;
      console.log(`✅ [${requestId}] Database connected in ${timings.db_connect_ms}ms`);
      
      // Log pool statistics
      console.log(`📊 [${requestId}] Pool stats: Total=${pool.totalCount}, Idle=${pool.idleCount}, Waiting=${pool.waitingCount}\n`);

    } catch (dbConnectError) {
      clearTimeout(requestTimeout);
      timings.db_connect_ms = Date.now() - dbConnectStart;
      
      console.error('\n' + '❌'.repeat(80));
      console.error(`🔌 [${requestId}] DATABASE CONNECTION FAILED`);
      console.error('❌'.repeat(80));
      console.error(`   Error: ${dbConnectError.message}`);
      console.error(`   Code: ${dbConnectError.code}`);
      console.error(`   Time taken: ${timings.db_connect_ms}ms`);
      console.error(`   Pool total: ${pool.totalCount}`);
      console.error(`   Pool idle: ${pool.idleCount}`);
      console.error(`   Pool waiting: ${pool.waitingCount}`);
      console.error('❌'.repeat(80) + '\n');

      return res.status(503).json({
        success: false,
        message: 'Database connection failed. Please try again.',
        requestId,
        debug: {
          error: dbConnectError.message,
          timings,
        },
      });
    }

    try {
      // ============================================================================
      // 📋 ACTION: LIST APPLICATIONS
      // ============================================================================
      if (action === 'list') {
        console.log(`📋 [${requestId}] Step 5: Processing 'list' action...`);
        console.log(`   - College ID: ${college_id}`);
        
        const queryStart = Date.now();
        console.log(`🔍 [${requestId}] Executing optimized JOIN query...`);
        
        // ✅ OPTIMIZED: Single query with JOIN instead of N+1 queries
        // ✅ SAFETY: LIMIT clause to prevent massive result sets
        // ✅ PERFORMANCE: Uses existing indexes on college_id and student_id
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

        timings.query_ms = Date.now() - queryStart;
        console.log(`✅ [${requestId}] Query completed in ${timings.query_ms}ms`);
        console.log(`📊 [${requestId}] Rows returned: ${result.rows.length}`);

        // Performance warning if query is slow
        if (timings.query_ms > 1000) {
          console.warn(`⚠️  [${requestId}] SLOW QUERY WARNING: ${timings.query_ms}ms (threshold: 1000ms)`);
          console.warn(`   Consider adding more specific indexes or reducing data size`);
        }

        // ============================================================================
        // 🔄 STEP 6: PROCESS AND GROUP RESULTS
        // ============================================================================
        const processingStart = Date.now();
        console.log(`🔄 [${requestId}] Step 6: Processing and grouping results...`);
        
        const applicationsMap = new Map();
        let documentCount = 0;

        for (const row of result.rows) {
          const appId = row.application_id;

          // Initialize application if not exists
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

          // Add document if exists (LEFT JOIN may have nulls)
          if (row.document_type && row.document_url) {
            applicationsMap.get(appId).documents.push({
              document_type: row.document_type,
              document_url: row.document_url,
            });
            documentCount++;
          }
        }

        const applications = Array.from(applicationsMap.values());
        timings.processing_ms = Date.now() - processingStart;
        timings.total_ms = Date.now() - startTime;

        console.log(`✅ [${requestId}] Processing completed in ${timings.processing_ms}ms`);
        console.log(`📦 [${requestId}] Results:`);
        console.log(`   - Applications: ${applications.length}`);
        console.log(`   - Total documents: ${documentCount}`);
        console.log(`   - Average docs per app: ${(documentCount / applications.length || 0).toFixed(2)}`);
        
        console.log(`\n⏱️  [${requestId}] PERFORMANCE SUMMARY:`);
        console.log(`   - Authorization: ${timings.authorization_ms}ms`);
        console.log(`   - DB Connect: ${timings.db_connect_ms}ms`);
        console.log(`   - Query: ${timings.query_ms}ms`);
        console.log(`   - Processing: ${timings.processing_ms}ms`);
        console.log(`   - TOTAL: ${timings.total_ms}ms`);
        console.log('='.repeat(80) + '\n');

        clearTimeout(requestTimeout);

        return res.status(200).json({
          success: true,
          applications,
          _debug: {
            requestId,
            timings,
            counts: {
              applications: applications.length,
              documents: documentCount,
              rows_returned: result.rows.length,
            },
          },
        });
      }

      // ============================================================================
      // ✅ ACTION: APPROVE APPLICATION
      // ============================================================================
      if (action === 'approve') {
        console.log(`✅ [${requestId}] Step 5: Processing 'approve' action...`);
        
        const { application_id } = req.body;

        if (!application_id) {
          clearTimeout(requestTimeout);
          console.error(`❌ [${requestId}] Missing application_id in request body\n`);
          
          return res.status(400).json({
            success: false,
            message: 'application_id is required',
            requestId,
          });
        }

        console.log(`   - Application ID: ${application_id}`);

        // Check college lock status
        const lockCheckStart = Date.now();
        const lockResult = await client.query(
          `SELECT is_final_approved FROM colleges WHERE id = $1`,
          [college_id]
        );
        timings.lock_check_ms = Date.now() - lockCheckStart;

        if (lockResult.rows.length === 0) {
          clearTimeout(requestTimeout);
          console.error(`❌ [${requestId}] College not found: ${college_id}\n`);
          
          return res.status(400).json({
            success: false,
            message: 'Invalid college',
            requestId,
          });
        }

        if (lockResult.rows[0].is_final_approved === true) {
          clearTimeout(requestTimeout);
          console.warn(`⚠️  [${requestId}] College is locked (final approved)\n`);
          
          return res.status(403).json({
            success: false,
            message: 'Final approval is locked. Cannot approve applications.',
            requestId,
          });
        }

        console.log(`✅ [${requestId}] College lock check passed in ${timings.lock_check_ms}ms`);

        // Verify application ownership and status
        const appCheckStart = Date.now();
        const appResult = await client.query(
          `SELECT sa.id, sa.status, s.college_id
           FROM student_applications sa
           INNER JOIN students s ON sa.student_id = s.id
           WHERE sa.id = $1`,
          [application_id]
        );
        timings.app_check_ms = Date.now() - appCheckStart;

        if (appResult.rows.length === 0) {
          clearTimeout(requestTimeout);
          console.error(`❌ [${requestId}] Application not found: ${application_id}\n`);
          
          return res.status(404).json({
            success: false,
            message: 'Application not found',
            requestId,
          });
        }

        const application = appResult.rows[0];

        if (application.college_id !== college_id) {
          clearTimeout(requestTimeout);
          console.error(`❌ [${requestId}] College mismatch: app=${application.college_id}, user=${college_id}\n`);
          
          return res.status(403).json({
            success: false,
            message: 'Unauthorized',
            requestId,
          });
        }

        if (application.status !== 'PENDING') {
          clearTimeout(requestTimeout);
          console.warn(`⚠️  [${requestId}] Application status is '${application.status}', not 'PENDING'\n`);
          
          return res.status(400).json({
            success: false,
            message: 'Only PENDING applications can be approved',
            requestId,
          });
        }

        console.log(`✅ [${requestId}] Application verification passed in ${timings.app_check_ms}ms`);

        // Update application status
        const updateStart = Date.now();
        await client.query(
          `UPDATE student_applications
           SET status = 'APPROVED', reviewed_at = NOW()
           WHERE id = $1`,
          [application_id]
        );
        timings.update_ms = Date.now() - updateStart;
        timings.total_ms = Date.now() - startTime;

        console.log(`✅ [${requestId}] Application approved in ${timings.update_ms}ms`);
        console.log(`⏱️  [${requestId}] Total time: ${timings.total_ms}ms`);
        console.log('='.repeat(80) + '\n');

        clearTimeout(requestTimeout);

        return res.status(200).json({
          success: true,
          message: 'Application approved successfully',
          requestId,
          _debug: { timings },
        });
      }

      // ============================================================================
      // ❌ ACTION: REJECT APPLICATION
      // ============================================================================
      if (action === 'reject') {
        console.log(`❌ [${requestId}] Step 5: Processing 'reject' action...`);
        
        const { application_id, rejected_reason } = req.body;

        if (!application_id) {
          clearTimeout(requestTimeout);
          console.error(`❌ [${requestId}] Missing application_id in request body\n`);
          
          return res.status(400).json({
            success: false,
            message: 'application_id is required',
            requestId,
          });
        }

        console.log(`   - Application ID: ${application_id}`);
        console.log(`   - Reason: ${rejected_reason || 'No reason provided'}`);

        // Check college lock status
        const lockCheckStart = Date.now();
        const lockResult = await client.query(
          `SELECT is_final_approved FROM colleges WHERE id = $1`,
          [college_id]
        );
        timings.lock_check_ms = Date.now() - lockCheckStart;

        if (lockResult.rows.length === 0) {
          clearTimeout(requestTimeout);
          console.error(`❌ [${requestId}] College not found: ${college_id}\n`);
          
          return res.status(400).json({
            success: false,
            message: 'Invalid college',
            requestId,
          });
        }

        if (lockResult.rows[0].is_final_approved === true) {
          clearTimeout(requestTimeout);
          console.warn(`⚠️  [${requestId}] College is locked (final approved)\n`);
          
          return res.status(403).json({
            success: false,
            message: 'Final approval is locked. Cannot reject applications.',
            requestId,
          });
        }

        console.log(`✅ [${requestId}] College lock check passed in ${timings.lock_check_ms}ms`);

        // Verify application ownership and status
        const appCheckStart = Date.now();
        const appResult = await client.query(
          `SELECT sa.id, sa.status, s.college_id
           FROM student_applications sa
           INNER JOIN students s ON sa.student_id = s.id
           WHERE sa.id = $1`,
          [application_id]
        );
        timings.app_check_ms = Date.now() - appCheckStart;

        if (appResult.rows.length === 0) {
          clearTimeout(requestTimeout);
          console.error(`❌ [${requestId}] Application not found: ${application_id}\n`);
          
          return res.status(404).json({
            success: false,
            message: 'Application not found',
            requestId,
          });
        }

        const application = appResult.rows[0];

        if (application.college_id !== college_id) {
          clearTimeout(requestTimeout);
          console.error(`❌ [${requestId}] College mismatch: app=${application.college_id}, user=${college_id}\n`);
          
          return res.status(403).json({
            success: false,
            message: 'Unauthorized',
            requestId,
          });
        }

        if (application.status !== 'PENDING') {
          clearTimeout(requestTimeout);
          console.warn(`⚠️  [${requestId}] Application status is '${application.status}', not 'PENDING'\n`);
          
          return res.status(400).json({
            success: false,
            message: 'Only PENDING applications can be rejected',
            requestId,
          });
        }

        console.log(`✅ [${requestId}] Application verification passed in ${timings.app_check_ms}ms`);

        // Update application status
        const updateStart = Date.now();
        await client.query(
          `UPDATE student_applications
           SET status = 'REJECTED', rejected_reason = $1, reviewed_at = NOW()
           WHERE id = $2`,
          [rejected_reason || null, application_id]
        );
        timings.update_ms = Date.now() - updateStart;
        timings.total_ms = Date.now() - startTime;

        console.log(`✅ [${requestId}] Application rejected in ${timings.update_ms}ms`);
        console.log(`⏱️  [${requestId}] Total time: ${timings.total_ms}ms`);
        console.log('='.repeat(80) + '\n');

        clearTimeout(requestTimeout);

        return res.status(200).json({
          success: true,
          message: 'Application rejected successfully',
          requestId,
          _debug: { timings },
        });
      }

      // ============================================================================
      // ⚠️ INVALID ACTION
      // ============================================================================
      clearTimeout(requestTimeout);
      timings.total_ms = Date.now() - startTime;
      
      console.error(`⚠️  [${requestId}] Invalid action: '${action}'\n`);
      
      return res.status(400).json({
        success: false,
        message: 'Invalid action',
        requestId,
        _debug: { timings },
      });

    } catch (queryError) {
      // ============================================================================
      // 💥 QUERY EXECUTION ERROR
      // ============================================================================
      clearTimeout(requestTimeout);
      timings.total_ms = Date.now() - startTime;
      
      console.error('\n' + '💥'.repeat(80));
      console.error(`💥 [${requestId}] QUERY EXECUTION ERROR`);
      console.error('💥'.repeat(80));
      console.error(`Error Name: ${queryError.name}`);
      console.error(`Error Message: ${queryError.message}`);
      console.error(`Error Code: ${queryError.code || 'N/A'}`);
      console.error(`SQL State: ${queryError.sqlState || 'N/A'}`);
      console.error(`Constraint: ${queryError.constraint || 'N/A'}`);
      console.error(`Detail: ${queryError.detail || 'N/A'}`);
      console.error(`Hint: ${queryError.hint || 'N/A'}`);
      console.error(`Position: ${queryError.position || 'N/A'}`);
      console.error(`\nStack Trace:`);
      console.error(queryError.stack);
      console.error(`\nTimings:`, JSON.stringify(timings, null, 2));
      console.error('💥'.repeat(80) + '\n');

      if (!res.headersSent) {
        return res.status(500).json({
          success: false,
          message: 'Database query failed. Please try again.',
          requestId,
          debug: process.env.NODE_ENV === 'development' ? {
            error: queryError.message,
            code: queryError.code,
            timings,
          } : { requestId },
        });
      }

    } finally {
      // ============================================================================
      // 🔌 DATABASE CONNECTION CLEANUP
      // ============================================================================
      if (client) {
        const releaseStart = Date.now();
        client.release();
        const releaseTime = Date.now() - releaseStart;
        console.log(`🔌 [${requestId}] Database connection released in ${releaseTime}ms`);
      }
    }

  } catch (fatalError) {
    // ============================================================================
    // 🔥 FATAL UNEXPECTED ERROR
    // ============================================================================
    clearTimeout(requestTimeout);
    timings.total_ms = Date.now() - startTime;
    
    console.error('\n' + '🔥'.repeat(80));
    console.error(`🔥 [${requestId}] FATAL UNEXPECTED ERROR`);
    console.error('🔥'.repeat(80));
    console.error(`Error Type: ${fatalError.constructor.name}`);
    console.error(`Error Message: ${fatalError.message}`);
    console.error(`\nStack Trace:`);
    console.error(fatalError.stack);
    console.error(`\nRequest Details:`);
    console.error(`   - User ID: ${req.user?.id}`);
    console.error(`   - College ID: ${req.user?.college_id}`);
    console.error(`   - Role: ${req.user?.role}`);
    console.error(`   - Action: ${req.body?.action}`);
    console.error(`\nTimings:`, JSON.stringify(timings, null, 2));
    console.error('🔥'.repeat(80) + '\n');

    if (!res.headersSent) {
      return res.status(500).json({
        success: false,
        message: 'An unexpected error occurred. Please try again.',
        requestId,
        debug: process.env.NODE_ENV === 'development' ? {
          error: fatalError.message,
          type: fatalError.constructor.name,
          timings,
        } : { requestId },
      });
    }
  }
};