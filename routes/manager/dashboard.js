const express = require('express');
const router = express.Router();
const pool = require('../../db/pool');
const { authenticate } = require('../../middleware/auth');
const requireRole = require('../../middleware/requireRole');
const { success, error } = require('../../utils/response');

// ============================================================================
// POST /api/manager/dashboard
// Get comprehensive dashboard statistics for manager/principal
// ============================================================================
router.post('/', authenticate, requireRole(['MANAGER', 'PRINCIPAL']), async (req, res) => {
  try {
    const { college_id, role, id: user_id } = req.user;

    // 1. GET COLLEGE INFO
    const collegeResult = await pool.query(
      `SELECT 
        college_code,
        college_name,
        place,
        max_quota,
        is_final_approved,
        final_approved_at
      FROM colleges
      WHERE id = $1`,
      [college_id]
    );

    if (collegeResult.rows.length === 0) {
      return error(res, 'College not found', 404);
    }

    const college = collegeResult.rows[0];

    // 2. COUNT TOTAL STUDENTS
    const totalStudentsResult = await pool.query(
      'SELECT COUNT(*) AS total FROM students WHERE college_id = $1',
      [college_id]
    );
    const total_students = parseInt(totalStudentsResult.rows[0].total);

    // 3. COUNT STUDENTS WITH APPLICATIONS
    const studentsWithAppsResult = await pool.query(
      `SELECT COUNT(DISTINCT sa.student_id) AS total
       FROM student_applications sa
       INNER JOIN students s ON sa.student_id = s.id
       WHERE s.college_id = $1`,
      [college_id]
    );
    const students_with_applications = parseInt(studentsWithAppsResult.rows[0].total);

    // 4. COUNT APPROVED STUDENTS
    const approvedResult = await pool.query(
      `SELECT COUNT(DISTINCT sa.student_id) AS total
       FROM student_applications sa
       INNER JOIN students s ON sa.student_id = s.id
       WHERE s.college_id = $1 AND sa.status = 'APPROVED'`,
      [college_id]
    );
    const approved_students = parseInt(approvedResult.rows[0].total);

    // 5. COUNT REJECTED STUDENTS
    const rejectedResult = await pool.query(
      `SELECT COUNT(DISTINCT sa.student_id) AS total
       FROM student_applications sa
       INNER JOIN students s ON sa.student_id = s.id
       WHERE s.college_id = $1 AND sa.status = 'REJECTED'`,
      [college_id]
    );
    const rejected_students = parseInt(rejectedResult.rows[0].total);

    // 6. COUNT ACCOMPANISTS
    const accompanistsResult = await pool.query(
      'SELECT COUNT(*) AS total FROM accompanists WHERE college_id = $1',
      [college_id]
    );
    const accompanists_count = parseInt(accompanistsResult.rows[0].total);

    // 7. COUNT PARTICIPATING EVENTS (DISTINCT EVENTS WITH PARTICIPANTS)
    // ✅ FIXED: Using CORRECT table names from Neon DB
    const participatingEventsResult = await pool.query(
      `SELECT (
        CASE WHEN EXISTS (
          SELECT 1 FROM event_classical_vocal_solo 
          WHERE college_id = $1 AND event_type = 'PARTICIPANT'
        ) THEN 1 ELSE 0 END +
        
        CASE WHEN EXISTS (
          SELECT 1 FROM event_light_vocal_solo 
          WHERE college_id = $1 AND event_type = 'PARTICIPANT'
        ) THEN 1 ELSE 0 END +
        
        CASE WHEN EXISTS (
          SELECT 1 FROM event_western_vocal_solo 
          WHERE college_id = $1 AND event_type = 'PARTICIPANT'
        ) THEN 1 ELSE 0 END +
        
        CASE WHEN EXISTS (
          SELECT 1 FROM event_classical_instr_percussion 
          WHERE college_id = $1 AND event_type = 'PARTICIPANT'
        ) THEN 1 ELSE 0 END +
        
        CASE WHEN EXISTS (
          SELECT 1 FROM event_classical_instr_non_percussion 
          WHERE college_id = $1 AND event_type = 'PARTICIPANT'
        ) THEN 1 ELSE 0 END +
        
        CASE WHEN EXISTS (
          SELECT 1 FROM event_folk_orchestra 
          WHERE college_id = $1 AND event_type = 'PARTICIPANT'
        ) THEN 1 ELSE 0 END +
        
        CASE WHEN EXISTS (
          SELECT 1 FROM event_group_song_indian 
          WHERE college_id = $1 AND event_type = 'PARTICIPANT'
        ) THEN 1 ELSE 0 END +
        
        CASE WHEN EXISTS (
          SELECT 1 FROM event_group_song_western 
          WHERE college_id = $1 AND event_type = 'PARTICIPANT'
        ) THEN 1 ELSE 0 END +
        
        CASE WHEN EXISTS (
          SELECT 1 FROM event_folk_dance 
          WHERE college_id = $1 AND event_type = 'PARTICIPANT'
        ) THEN 1 ELSE 0 END +
        
        CASE WHEN EXISTS (
          SELECT 1 FROM event_classical_dance_solo 
          WHERE college_id = $1 AND event_type = 'PARTICIPANT'
        ) THEN 1 ELSE 0 END +
        
        CASE WHEN EXISTS (
          SELECT 1 FROM event_mime 
          WHERE college_id = $1 AND event_type = 'PARTICIPANT'
        ) THEN 1 ELSE 0 END +
        
        CASE WHEN EXISTS (
          SELECT 1 FROM event_mimicry 
          WHERE college_id = $1 AND event_type = 'PARTICIPANT'
        ) THEN 1 ELSE 0 END +
        
        CASE WHEN EXISTS (
          SELECT 1 FROM event_one_act_play 
          WHERE college_id = $1 AND event_type = 'PARTICIPANT'
        ) THEN 1 ELSE 0 END +
        
        CASE WHEN EXISTS (
          SELECT 1 FROM event_skits 
          WHERE college_id = $1 AND event_type = 'PARTICIPANT'
        ) THEN 1 ELSE 0 END +
        
        CASE WHEN EXISTS (
          SELECT 1 FROM event_debate 
          WHERE college_id = $1 AND event_type = 'PARTICIPANT'
        ) THEN 1 ELSE 0 END +
        
        CASE WHEN EXISTS (
          SELECT 1 FROM event_elocution 
          WHERE college_id = $1 AND event_type = 'PARTICIPANT'
        ) THEN 1 ELSE 0 END +
        
        CASE WHEN EXISTS (
          SELECT 1 FROM event_quiz 
          WHERE college_id = $1 AND event_type = 'PARTICIPANT'
        ) THEN 1 ELSE 0 END +
        
        CASE WHEN EXISTS (
          SELECT 1 FROM event_cartooning 
          WHERE college_id = $1 AND event_type = 'PARTICIPANT'
        ) THEN 1 ELSE 0 END +
        
        CASE WHEN EXISTS (
          SELECT 1 FROM event_clay_modelling 
          WHERE college_id = $1 AND event_type = 'PARTICIPANT'
        ) THEN 1 ELSE 0 END +
        
        CASE WHEN EXISTS (
          SELECT 1 FROM event_collage_making 
          WHERE college_id = $1 AND event_type = 'PARTICIPANT'
        ) THEN 1 ELSE 0 END +
        
        CASE WHEN EXISTS (
          SELECT 1 FROM event_installation 
          WHERE college_id = $1 AND event_type = 'PARTICIPANT'
        ) THEN 1 ELSE 0 END +
        
        CASE WHEN EXISTS (
          SELECT 1 FROM event_on_spot_painting 
          WHERE college_id = $1 AND event_type = 'PARTICIPANT'
        ) THEN 1 ELSE 0 END +
        
        CASE WHEN EXISTS (
          SELECT 1 FROM event_poster_making 
          WHERE college_id = $1 AND event_type = 'PARTICIPANT'
        ) THEN 1 ELSE 0 END +
        
        CASE WHEN EXISTS (
          SELECT 1 FROM event_rangoli 
          WHERE college_id = $1 AND event_type = 'PARTICIPANT'
        ) THEN 1 ELSE 0 END +
        
        CASE WHEN EXISTS (
          SELECT 1 FROM event_spot_photography 
          WHERE college_id = $1 AND event_type = 'PARTICIPANT'
        ) THEN 1 ELSE 0 END
      ) AS event_count`,
      [college_id]
    );
    const participating_event_count = parseInt(participatingEventsResult.rows[0].event_count);

    // 8. GET ACCOMMODATION STATUS
    const accommodationResult = await pool.query(
      `SELECT 
        total_boys,
        total_girls,
        status,
        applied_at
      FROM accommodation_requests
      WHERE college_id = $1`,
      [college_id]
    );

    let accommodation = null;
    if (accommodationResult.rows.length > 0) {
      const acc = accommodationResult.rows[0];
      accommodation = {
        total_boys: acc.total_boys,
        total_girls: acc.total_girls,
        status: acc.status || 'PENDING',
        applied_at: acc.applied_at,
      };
    }

    // 9. GET PAYMENT STATUS
    const paymentResult = await pool.query(
      `SELECT 
        status,
        uploaded_at,
        admin_remarks
      FROM payment_receipts
      WHERE college_id = $1`,
      [college_id]
    );

    let payment_status = null;
    if (paymentResult.rows.length > 0) {
      const pay = paymentResult.rows[0];
      payment_status = {
        status: pay.status,
        uploaded_at: pay.uploaded_at,
        admin_remarks: pay.admin_remarks,
      };
    }

    // 10. CHECK IF TEAM MANAGER EXISTS (FOR PRINCIPAL)
    let has_team_manager = false;
    if (role === 'PRINCIPAL') {
      const managerResult = await pool.query(
        `SELECT COUNT(*) AS total
         FROM users
         WHERE college_id = $1 AND role = 'MANAGER' AND is_active = true`,
        [college_id]
      );
      has_team_manager = parseInt(managerResult.rows[0].total) > 0;
    }

    // 11. CALCULATE QUOTA
    const quota_used = approved_students + accompanists_count;

    // 12. BUILD RESPONSE
    return success(res, {
      college: {
        college_code: college.college_code,
        college_name: college.college_name,
        place: college.place,
        max_quota: college.max_quota,
      },
      stats: {
        total_students,
        students_with_applications,
        approved_students,
        rejected_students,
        accompanists_count,
        quota_used,
        quota_remaining: college.max_quota - quota_used,
        participating_event_count,
      },
      accommodation,
      payment_status,
      is_final_approved: college.is_final_approved === true,
      final_approved_at: college.final_approved_at,
      has_team_manager,
    });

  } catch (err) {
    console.error('Manager dashboard error:', err);
    return error(res, 'Failed to load dashboard', 500);
  }
});

module.exports = router;