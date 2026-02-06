// routes/principal/final-approval.js
// ✅ PRODUCTION-READY: Complete migration from Azure SQL to Neon DB
// Includes: Event validation, Accompanists, QR codes, All document URLs

const express = require('express');
const router = express.Router();
const pool = require('../../db/pool');
const { authenticate } = require('../../middleware/auth');
const requireRole = require('../../middleware/requireRole');

// Apply middleware
router.use(authenticate);
router.use(requireRole(['PRINCIPAL']));

// ============================================================================
// POST /api/principal/final-approval
// Perform final approval with complete data migration
// ============================================================================
router.post('/', async (req, res) => {
  // 🔍 DEBUGGING: Track request timing
  const requestId = `REQ-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  const startTime = Date.now();
  
  console.log('┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(`🔍 [${requestId}] FINAL-APPROVAL: Request started`);
  console.log(`🔍 [${requestId}] Timestamp: ${new Date().toISOString()}`);
  console.log(`🔍 [${requestId}] User ID: ${req.user?.id}`);
  console.log(`🔍 [${requestId}] College ID: ${req.user?.college_id}`);
  console.log(`🔍 [${requestId}] Role: ${req.user?.role}`);
  
  // ⏱️ TIMEOUT PROTECTION: Respond before Railway's 10s timeout
  let timeoutOccurred = false;
  const requestTimeout = setTimeout(() => {
    timeoutOccurred = true;
    const elapsed = Date.now() - startTime;
    console.error(`🔍 [${requestId}] ⏱️ TIMEOUT after ${elapsed}ms`);
    
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
    console.log(`🔍 [${requestId}] 🔌 Acquiring database connection...`);
    client = await pool.connect();
    const dbConnectTime = Date.now() - dbConnectStart;
    console.log(`🔍 [${requestId}] ✅ Database connected in ${dbConnectTime}ms`);

    try {
      console.log(`🔍 [${requestId}] 🔒 Starting transaction with SERIALIZABLE isolation...`);
      await client.query('BEGIN ISOLATION LEVEL SERIALIZABLE');

      // ========================================================================
      // STEP 1: Lock college row and check if already approved
      // ========================================================================
      const lockResult = await client.query(
        `SELECT is_final_approved, college_code, college_name 
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

      const college = lockResult.rows[0];

      if (college.is_final_approved === true) {
        await client.query('ROLLBACK');
        clearTimeout(requestTimeout);
        return res.status(403).json({
          success: false,
          message: 'Final approval already submitted',
          requestId,
        });
      }

      console.log(`🔍 [${requestId}] 📊 College: ${college.college_name} (${college.college_code})`);

      // ========================================================================
      // STEP 2: Get ELIGIBLE STUDENTS with ALL required data
      // - Join students + student_applications + application_documents + colleges
      // - Filter by APPROVED status
      // - Validate appears in at least ONE event table
      // ========================================================================
      console.log(`🔍 [${requestId}] 🔍 Fetching eligible students with event validation...`);
      const studentsQueryStart = Date.now();

      const studentsResult = await client.query(
        `SELECT DISTINCT
           s.id AS student_id,
           s.full_name,
           s.usn,
           s.email,
           s.phone,
           s.gender,
           s.passport_photo_url,
           sa.id AS application_id,
           sa.blood_group,
           sa.address,
           sa.department,
           sa.year_of_study,
           sa.semester,
           sa.college_code,
           c.college_name,
           -- Get document URLs from application_documents table
           MAX(CASE WHEN ad.document_type = 'aadhaar' THEN ad.document_url END) AS aadhaar_url,
           MAX(CASE WHEN ad.document_type = 'college_id_card' THEN ad.document_url END) AS college_id_card_url,
           MAX(CASE WHEN ad.document_type = 'sslc' THEN ad.document_url END) AS sslc_url
         FROM students s
         INNER JOIN student_applications sa ON s.id = sa.student_id
         INNER JOIN colleges c ON s.college_id = c.id
         LEFT JOIN application_documents ad ON sa.id = ad.application_id
         WHERE s.college_id = $1
           AND sa.status = 'APPROVED'
           AND (
             EXISTS (SELECT 1 FROM event_classical_vocal_solo WHERE student_id = s.id AND college_id = s.college_id)
             OR EXISTS (SELECT 1 FROM event_light_vocal_solo WHERE student_id = s.id AND college_id = s.college_id)
             OR EXISTS (SELECT 1 FROM event_western_vocal_solo WHERE student_id = s.id AND college_id = s.college_id)
             OR EXISTS (SELECT 1 FROM event_classical_instr_percussion WHERE student_id = s.id AND college_id = s.college_id)
             OR EXISTS (SELECT 1 FROM event_classical_instr_non_percussion WHERE student_id = s.id AND college_id = s.college_id)
             OR EXISTS (SELECT 1 FROM event_group_song_indian WHERE student_id = s.id AND college_id = s.college_id)
             OR EXISTS (SELECT 1 FROM event_group_song_western WHERE student_id = s.id AND college_id = s.college_id)
             OR EXISTS (SELECT 1 FROM event_folk_orchestra WHERE student_id = s.id AND college_id = s.college_id)
             OR EXISTS (SELECT 1 FROM event_classical_dance_solo WHERE student_id = s.id AND college_id = s.college_id)
             OR EXISTS (SELECT 1 FROM event_folk_dance WHERE student_id = s.id AND college_id = s.college_id)
             OR EXISTS (SELECT 1 FROM event_mime WHERE student_id = s.id AND college_id = s.college_id)
             OR EXISTS (SELECT 1 FROM event_mimicry WHERE student_id = s.id AND college_id = s.college_id)
             OR EXISTS (SELECT 1 FROM event_one_act_play WHERE student_id = s.id AND college_id = s.college_id)
             OR EXISTS (SELECT 1 FROM event_skits WHERE student_id = s.id AND college_id = s.college_id)
             OR EXISTS (SELECT 1 FROM event_debate WHERE student_id = s.id AND college_id = s.college_id)
             OR EXISTS (SELECT 1 FROM event_elocution WHERE student_id = s.id AND college_id = s.college_id)
             OR EXISTS (SELECT 1 FROM event_quiz WHERE student_id = s.id AND college_id = s.college_id)
             OR EXISTS (SELECT 1 FROM event_cartooning WHERE student_id = s.id AND college_id = s.college_id)
             OR EXISTS (SELECT 1 FROM event_clay_modelling WHERE student_id = s.id AND college_id = s.college_id)
             OR EXISTS (SELECT 1 FROM event_collage_making WHERE student_id = s.id AND college_id = s.college_id)
             OR EXISTS (SELECT 1 FROM event_installation WHERE student_id = s.id AND college_id = s.college_id)
             OR EXISTS (SELECT 1 FROM event_on_spot_painting WHERE student_id = s.id AND college_id = s.college_id)
             OR EXISTS (SELECT 1 FROM event_poster_making WHERE student_id = s.id AND college_id = s.college_id)
             OR EXISTS (SELECT 1 FROM event_rangoli WHERE student_id = s.id AND college_id = s.college_id)
             OR EXISTS (SELECT 1 FROM event_spot_photography WHERE student_id = s.id AND college_id = s.college_id)
           )
         GROUP BY s.id, s.full_name, s.usn, s.email, s.phone, s.gender, s.passport_photo_url,
                  sa.id, sa.blood_group, sa.address, sa.department, sa.year_of_study, 
                  sa.semester, sa.college_code, c.college_name
         ORDER BY s.id`,
        [college_id]
      );

      const studentsQueryTime = Date.now() - studentsQueryStart;
      console.log(`🔍 [${requestId}] ✅ Students fetched in ${studentsQueryTime}ms`);

      const eligibleStudents = studentsResult.rows;
      console.log(`🔍 [${requestId}] 📊 Eligible students count: ${eligibleStudents.length}`);

      // ========================================================================
      // STEP 3: Get ALL accompanists (no event filtering needed)
      // ========================================================================
      console.log(`🔍 [${requestId}] 🔍 Fetching accompanists...`);
      const accompanistsQueryStart = Date.now();

      const accompanistsResult = await client.query(
        `SELECT 
           a.id AS accompanist_id,
           a.college_id,
           a.college_name,
           a.full_name,
           a.phone,
           a.email,
           a.accompanist_type,
           a.student_id,
           a.passport_photo_url,
           a.id_proof_url,
           a.college_id_card_url,
           a.is_team_manager,
           c.college_code
         FROM accompanists a
         INNER JOIN colleges c ON a.college_id = c.id
         WHERE a.college_id = $1
           AND a.is_active = true
         ORDER BY a.id`,
        [college_id]
      );

      const accompanistsQueryTime = Date.now() - accompanistsQueryStart;
      console.log(`🔍 [${requestId}] ✅ Accompanists fetched in ${accompanistsQueryTime}ms`);

      const accompanists = accompanistsResult.rows;
      console.log(`🔍 [${requestId}] 📊 Accompanists count: ${accompanists.length}`);

      // ========================================================================
      // STEP 4: Validate we have participants to approve
      // ========================================================================
      const total_participants = eligibleStudents.length + accompanists.length;

      if (total_participants === 0) {
        await client.query('ROLLBACK');
        clearTimeout(requestTimeout);
        return res.status(400).json({
          success: false,
          message: 'No eligible participants found for final approval',
          details: 'No approved students in events and no accompanists found.',
          requestId,
        });
      }

      // ========================================================================
      // STEP 5: Check for students who are ALSO accompanists (avoid duplicates)
      // ========================================================================
      const studentIdsSet = new Set(eligibleStudents.map(s => s.student_id));
      const accompanistStudentIds = accompanists
        .filter(a => a.student_id !== null)
        .map(a => a.student_id);
      
      // Filter out accompanists who are already in the student list
      const uniqueAccompanists = accompanists.filter(a => 
        a.student_id === null || !studentIdsSet.has(a.student_id)
      );

      const duplicates_removed = accompanists.length - uniqueAccompanists.length;
      if (duplicates_removed > 0) {
        console.log(`🔍 [${requestId}] 🔄 Removed ${duplicates_removed} duplicate student-accompanists`);
      }

      const actual_total = eligibleStudents.length + uniqueAccompanists.length;

      // ========================================================================
      // STEP 6: PRE-RESERVE QR CODES (Single batch query)
      // ========================================================================
      console.log(`🔍 [${requestId}] 🎫 Reserving ${actual_total} QR codes...`);
      const qrReserveStart = Date.now();

      const qrReserveResult = await client.query(
        `SELECT id, qr_code 
         FROM qr_code_pool 
         WHERE is_used = false 
         ORDER BY id
         FOR UPDATE SKIP LOCKED 
         LIMIT $1`,
        [actual_total]
      );

      const qrReserveTime = Date.now() - qrReserveStart;
      console.log(`🔍 [${requestId}] ✅ QR codes reserved in ${qrReserveTime}ms`);

      const reserved_qr_codes = qrReserveResult.rows;

      if (reserved_qr_codes.length < actual_total) {
        await client.query('ROLLBACK');
        clearTimeout(requestTimeout);
        return res.status(500).json({
          success: false,
          message: 'QR code pool exhausted. Cannot complete final approval.',
          details: `Need ${actual_total} QR codes, but only ${reserved_qr_codes.length} available.`,
          requestId,
        });
      }

      // ========================================================================
      // STEP 7: Insert STUDENTS with parameterized queries
      // ========================================================================
      console.log(`🔍 [${requestId}] 💾 Inserting students...`);
      const insertStudentsStart = Date.now();

      let qr_index = 0;
      let inserted_students = 0;
      const qr_pool_ids = []; // Track QR pool IDs for batch update

      for (const student of eligibleStudents) {
        const { id: qr_pool_id, qr_code } = reserved_qr_codes[qr_index++];

        const insertResult = await client.query(
          `INSERT INTO final_event_participants_master (
             college_id,
             person_type,
             student_id,
             accompanist_id,
             application_id,
             full_name,
             usn,
             phone,
             email,
             gender,
             blood_group,
             address,
             department,
             year_of_study,
             semester,
             college_code,
             college_name,
             passport_photo_url,
             aadhaar_url,
             college_id_card_url,
             sslc_url,
             id_proof_url,
             accompanist_type,
             is_team_manager,
             qr_code,
             qr_assigned_at,
             final_approved_by
           )
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24, $25, NOW(), $26)
           RETURNING id`,
          [
            college_id,
            'STUDENT',
            student.student_id,
            null, // accompanist_id
            student.application_id,
            student.full_name,
            student.usn,
            student.phone,
            student.email,
            student.gender,
            student.blood_group,
            student.address,
            student.department,
            student.year_of_study,
            student.semester,
            student.college_code,
            student.college_name,
            student.passport_photo_url,
            student.aadhaar_url,
            student.college_id_card_url,
            student.sslc_url,
            null, // id_proof_url (only for accompanists)
            null, // accompanist_type
            false, // is_team_manager
            qr_code,
            principal_user_id
          ]
        );

        const participant_id = insertResult.rows[0].id;
        qr_pool_ids.push({ pool_id: qr_pool_id, participant_id });

        inserted_students++;
      }

      const insertStudentsTime = Date.now() - insertStudentsStart;
      console.log(`🔍 [${requestId}] ✅ ${inserted_students} students inserted in ${insertStudentsTime}ms`);

      // ========================================================================
      // STEP 8: Insert ACCOMPANISTS with parameterized queries
      // ========================================================================
      console.log(`🔍 [${requestId}] 💾 Inserting accompanists...`);
      const insertAccompanistsStart = Date.now();

      let inserted_accompanists = 0;

      for (const acc of uniqueAccompanists) {
        const { id: qr_pool_id, qr_code } = reserved_qr_codes[qr_index++];

        const insertResult = await client.query(
          `INSERT INTO final_event_participants_master (
             college_id,
             person_type,
             student_id,
             accompanist_id,
             application_id,
             full_name,
             usn,
             phone,
             email,
             gender,
             blood_group,
             address,
             department,
             year_of_study,
             semester,
             college_code,
             college_name,
             passport_photo_url,
             aadhaar_url,
             college_id_card_url,
             sslc_url,
             id_proof_url,
             accompanist_type,
             is_team_manager,
             qr_code,
             qr_assigned_at,
             final_approved_by
           )
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24, $25, NOW(), $26)
           RETURNING id`,
          [
            college_id,
            'ACCOMPANIST',
            acc.student_id, // may be null if not a student
            acc.accompanist_id,
            null, // application_id (accompanists don't have applications)
            acc.full_name,
            null, // usn (accompanists don't have USN)
            acc.phone,
            acc.email,
            null, // gender (not tracked for accompanists)
            null, // blood_group
            null, // address
            null, // department
            null, // year_of_study
            null, // semester
            acc.college_code,
            acc.college_name,
            acc.passport_photo_url,
            null, // aadhaar_url (not required for accompanists)
            acc.college_id_card_url,
            null, // sslc_url (not required for accompanists)
            acc.id_proof_url,
            acc.accompanist_type,
            acc.is_team_manager,
            qr_code,
            principal_user_id
          ]
        );

        const participant_id = insertResult.rows[0].id;
        qr_pool_ids.push({ pool_id: qr_pool_id, participant_id });

        inserted_accompanists++;
      }

      const insertAccompanistsTime = Date.now() - insertAccompanistsStart;
      console.log(`🔍 [${requestId}] ✅ ${inserted_accompanists} accompanists inserted in ${insertAccompanistsTime}ms`);

      // ========================================================================
      // STEP 9: Mark ALL reserved QR codes as used (BATCH UPDATE)
      // ========================================================================
      console.log(`🔍 [${requestId}] 🎫 Marking QR codes as used...`);
      const qrUpdateStart = Date.now();

      if (qr_pool_ids.length > 0) {
        const poolIds = qr_pool_ids.map(q => q.pool_id);
        const caseStatements = qr_pool_ids
          .map(q => `WHEN ${q.pool_id} THEN ${q.participant_id}`)
          .join(' ');

        await client.query(
          `UPDATE qr_code_pool 
           SET 
             is_used = true, 
             assigned_to_person_id = CASE id ${caseStatements} END,
             assigned_at = NOW()
           WHERE id = ANY($1::int[])`,
          [poolIds]
        );
      }

      const qrUpdateTime = Date.now() - qrUpdateStart;
      console.log(`🔍 [${requestId}] ✅ QR codes marked as used in ${qrUpdateTime}ms`);

      // ========================================================================
      // STEP 10: Set final approval flag on college
      // ========================================================================
      await client.query(
        `UPDATE colleges 
         SET 
           is_final_approved = true,
           final_approved_at = NOW(),
           final_approved_by = $1
         WHERE id = $2`,
        [principal_user_id, college_id]
      );

      // ========================================================================
      // COMMIT - All or nothing
      // ========================================================================
      console.log(`🔍 [${requestId}] 🔐 Committing transaction...`);
      await client.query('COMMIT');

      const totalTime = Date.now() - startTime;
      console.log(`🔍 [${requestId}] ✅ Final approval completed successfully in ${totalTime}ms`);
      console.log('┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

      clearTimeout(requestTimeout);

      return res.status(200).json({
        success: true,
        message: 'Final approval successful. All registrations are now locked.',
        data: {
          inserted_students,
          inserted_accompanists,
          total_participants: inserted_students + inserted_accompanists,
          duplicates_removed
        },
        _debug: {
          requestId,
          timings: {
            db_connect_ms: dbConnectTime,
            students_query_ms: studentsQueryTime,
            accompanists_query_ms: accompanistsQueryTime,
            qr_reserve_ms: qrReserveTime,
            insert_students_ms: insertStudentsTime,
            insert_accompanists_ms: insertAccompanistsTime,
            qr_update_ms: qrUpdateTime,
            total_ms: totalTime,
          },
        },
      });

    } catch (txError) {
      console.log(`🔍 [${requestId}] 🔄 Rolling back transaction...`);
      await client.query('ROLLBACK');

      clearTimeout(requestTimeout);
      const elapsed = Date.now() - startTime;

      if (txError.code === '40001') {
        console.error(`🔍 [${requestId}] ⚠️ Serialization conflict after ${elapsed}ms`);
        return res.status(409).json({
          success: false,
          message: 'Concurrent transaction conflict. Please retry.',
          details: 'Another transaction modified the same data. Try again.',
          requestId,
        });
      }

      console.error('┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
      console.error(`🔍 [${requestId}] ❌ TRANSACTION ERROR after ${elapsed}ms`);
      console.error(`🔍 [${requestId}] Error:`, txError);
      console.error('┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

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
    
    console.error('┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.error(`🔍 [${requestId}] ❌ FATAL ERROR after ${elapsed}ms`);
    console.error(`🔍 [${requestId}] Error:`, error);
    console.error('┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

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
      console.log(`🔍 [${requestId}] 🔌 Database connection released`);
    }
  }
});

module.exports = router;