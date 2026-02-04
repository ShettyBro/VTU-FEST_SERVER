// routes/principal/final-approval.js
// ✅ PRODUCTION-READY: Optimized with timeout protection and better error handling

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
// POST /api/principal/final-approval
// Perform final approval and assign QR codes to all approved students
// ============================================================================
router.post('/', async (req, res) => {
  // 🔍 DEBUGGING: Track request timing
  const requestId = `REQ-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  const startTime = Date.now();
  
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(`📍 [${requestId}] FINAL-APPROVAL: Request started`);
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
        message: 'Request timeout. The final approval process is taking longer than expected. Please try again.',
        requestId,
        elapsed_ms: elapsed,
      });
    }
  }, 9000); // 9 seconds (before Railway's 10s limit)

  const principal_user_id = req.user.id;
  const college_id = req.user.college_id;
  const role = req.user.role;

  if (!principal_user_id || !college_id || role !== 'PRINCIPAL') {
    clearTimeout(requestTimeout);
    return res.status(403).json({
      success: false,
      message: 'Unauthorized: Only PRINCIPAL can perform final approval',
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

    try {
      console.log(`📍 [${requestId}] 🔒 Starting transaction with SERIALIZABLE isolation...`);
      await client.query('BEGIN ISOLATION LEVEL SERIALIZABLE');

      // Check if already approved
      const lockResult = await client.query(
        `SELECT is_final_approved 
         FROM colleges 
         WHERE id = $1 
         FOR UPDATE`,
        [college_id]
      );

      if (lockResult.rows.length === 0) {
        await client.query('ROLLBACK');
        clearTimeout(requestTimeout);
        return res.status(404).json({
          success: false,
          message: 'College not found',
          requestId,
        });
      }

      if (lockResult.rows[0].is_final_approved === true) {
        await client.query('ROLLBACK');
        clearTimeout(requestTimeout);
        return res.status(403).json({
          success: false,
          message: 'Final approval already submitted',
          requestId,
        });
      }

      console.log(`📍 [${requestId}] 🔍 Fetching approved students...`);
      const studentsQueryStart = Date.now();

      // ✅ OPTIMIZED: Single query to get all approved students
      const studentsResult = await client.query(
        `SELECT 
           s.id,
           s.full_name,
           s.phone,
           s.email,
           s.passport_photo_url
         FROM students s
         INNER JOIN student_applications sa ON s.id = sa.student_id
         WHERE s.college_id = $1
           AND sa.status = 'APPROVED'
         ORDER BY s.id`,
        [college_id]
      );

      const studentsQueryTime = Date.now() - studentsQueryStart;
      console.log(`📍 [${requestId}] ✅ Students fetched in ${studentsQueryTime}ms`);

      const approvedStudents = studentsResult.rows;
      console.log(`📍 [${requestId}] 📊 Approved students count: ${approvedStudents.length}`);

      if (approvedStudents.length === 0) {
        await client.query('ROLLBACK');
        clearTimeout(requestTimeout);
        return res.status(400).json({
          success: false,
          message: 'No approved students found for final approval',
          requestId,
        });
      }

      console.log(`📍 [${requestId}] 🎫 Reserving ${approvedStudents.length} QR codes...`);
      const qrReserveStart = Date.now();

      // Reserve QR codes
      const qrReserveResult = await client.query(
        `SELECT id, qr_code 
         FROM qr_code_pool 
         WHERE is_used = false 
         ORDER BY id
         FOR UPDATE SKIP LOCKED 
         LIMIT $1`,
        [approvedStudents.length]
      );

      const qrReserveTime = Date.now() - qrReserveStart;
      console.log(`📍 [${requestId}] ✅ QR codes reserved in ${qrReserveTime}ms`);

      const reserved_qr_codes = qrReserveResult.rows;

      if (reserved_qr_codes.length < approvedStudents.length) {
        await client.query('ROLLBACK');
        clearTimeout(requestTimeout);
        return res.status(500).json({
          success: false,
          message: 'QR code pool exhausted. Cannot complete final approval.',
          details: `Need ${approvedStudents.length} QR codes, but only ${reserved_qr_codes.length} available.`,
          requestId,
        });
      }

      console.log(`📍 [${requestId}] 💾 Inserting participants and updating QR codes...`);
      const insertStart = Date.now();

      // ✅ OPTIMIZED: Batch insert all participants at once
      const values = approvedStudents.map((student, index) => {
        const { id: qr_pool_id, qr_code } = reserved_qr_codes[index];
        return `(${college_id}, 'STUDENT', ${student.id}, NULL, '${student.full_name.replace(/'/g, "''")}', '${student.phone}', '${student.email}', ${student.passport_photo_url ? `'${student.passport_photo_url}'` : 'NULL'}, NULL, '${qr_code}', NOW())`;
      }).join(',');

      const insertResult = await client.query(
        `INSERT INTO final_event_participants_master (
           college_id,
           person_type,
           student_id,
           accompanist_id,
           name,
           phone,
           email,
           passport_photo_url,
           id_proof_url,
           qr_code,
           qr_assigned_at
         )
         VALUES ${values}
         RETURNING id`
      );

      const participant_ids = insertResult.rows.map(r => r.id);
      const inserted_students = participant_ids.length;

      // ✅ OPTIMIZED: Batch update QR codes
      const poolIds = reserved_qr_codes.map(q => q.id);
      const caseStatements = reserved_qr_codes
        .map((q, index) => `WHEN ${q.id} THEN ${participant_ids[index]}`)
        .join(' ');

      await client.query(
        `UPDATE qr_code_pool 
         SET 
           is_used = true, 
           assigned_to_person_id = CASE id ${caseStatements} END
         WHERE id = ANY($1::int[])`,
        [poolIds]
      );

      const insertTime = Date.now() - insertStart;
      console.log(`📍 [${requestId}] ✅ Participants inserted and QR codes updated in ${insertTime}ms`);

      // Lock the college
      await client.query(
        `UPDATE colleges 
         SET 
           is_final_approved = true,
           final_approved_at = NOW(),
           final_approved_by = $1
         WHERE id = $2`,
        [principal_user_id, college_id]
      );

      console.log(`📍 [${requestId}] 🔓 Committing transaction...`);
      await client.query('COMMIT');

      const totalTime = Date.now() - startTime;
      console.log(`📍 [${requestId}] ✅ Final approval completed successfully in ${totalTime}ms`);
      console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

      clearTimeout(requestTimeout);

      return res.status(200).json({
        success: true,
        message: 'Final approval successful. All registrations are now locked.',
        data: {
          inserted_students,
          total_participants: inserted_students
        },
        _debug: {
          requestId,
          timings: {
            db_connect_ms: dbConnectTime,
            students_query_ms: studentsQueryTime,
            qr_reserve_ms: qrReserveTime,
            insert_ms: insertTime,
            total_ms: totalTime,
          },
        },
      });

    } catch (txError) {
      console.log(`📍 [${requestId}] 🔄 Rolling back transaction...`);
      await client.query('ROLLBACK');

      clearTimeout(requestTimeout);
      const elapsed = Date.now() - startTime;

      if (txError.code === '40001') {
        console.error(`📍 [${requestId}] ⚠️ Serialization conflict after ${elapsed}ms`);
        return res.status(409).json({
          success: false,
          message: 'Concurrent transaction conflict. Please retry.',
          details: 'Another transaction modified the same data. Try again.',
          requestId,
        });
      }

      console.error('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
      console.error(`📍 [${requestId}] ❌ TRANSACTION ERROR after ${elapsed}ms`);
      console.error(`📍 [${requestId}] Error:`, txError);
      console.error('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

      if (!res.headersSent) {
        return res.status(500).json({
          success: false,
          message: 'Internal server error during final approval',
          requestId,
          error: process.env.NODE_ENV === 'development' ? txError.message : undefined,
        });
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
        message: 'Internal server error during final approval',
        requestId,
        error: process.env.NODE_ENV === 'development' ? error.message : undefined,
      });
    }

  } finally {
    if (client) {
      client.release();
      console.log(`📍 [${requestId}] 🔌 Database connection released`);
    }
  }
});

module.exports = router;