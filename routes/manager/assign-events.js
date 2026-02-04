const express = require('express');
const router = express.Router();
const pool = require('../../db/pool');
const { authenticate } = require('../../middleware/auth');
const requireRole = require('../../middleware/requireRole');
const checkCollegeLock = require('../../middleware/checkCollegeLock');
const { success, error, validationError } = require('../../utils/response');

// ============================================================================
// EVENT SLUG TO TABLE MAPPING (25 EVENTS) - ✅ FIXED: MATCHING NEON DB
// ============================================================================
const EVENT_TABLES = {
  'mime': 'event_mime',
  'mimicry': 'event_mimicry',
  'one_act_play': 'event_one_act_play',
  'skits': 'event_skits',
  'debate': 'event_debate',
  'elocution': 'event_elocution',
  'quiz': 'event_quiz',
  'cartooning': 'event_cartooning',
  'clay_modelling': 'event_clay_modelling',
  'collage_making': 'event_collage_making',
  'installation': 'event_installation',
  'on_spot_painting': 'event_on_spot_painting',
  'poster_making': 'event_poster_making',
  'rangoli': 'event_rangoli',
  'spot_photography': 'event_spot_photography',
  'classical_vocal_solo': 'event_classical_vocal_solo',
  'classical_instrumental_percussion': 'event_classical_instr_percussion',       // ✅ FIXED: ABBREVIATED
  'classical_instrumental_non_percussion': 'event_classical_instr_non_percussion', // ✅ FIXED: ABBREVIATED
  'light_vocal_solo': 'event_light_vocal_solo',
  'western_vocal_solo': 'event_western_vocal_solo',
  'group_song_indian': 'event_group_song_indian',
  'group_song_western': 'event_group_song_western',
  'folk_orchestra': 'event_folk_orchestra',
  'folk_tribal_dance': 'event_folk_dance',  // ✅ FIXED: folk_tribal_dance → folk_dance
  'classical_dance_solo': 'event_classical_dance_solo',
};

// ============================================================================
// POST /api/manager/assign-events
// Multi-action endpoint for event assignment management
// ============================================================================
router.post('/', authenticate, requireRole(['MANAGER', 'PRINCIPAL']), async (req, res) => {
  const { action } = req.body;
  const { college_id, id: user_id } = req.user;

  if (!action) {
    return validationError(res, 'Action is required');
  }

  try {
    // ========================================================================
    // ACTION: fetch - Get assignments for specific event
    // ========================================================================
    if (action === 'fetch') {
      const { event_slug } = req.body;

      if (!event_slug || !EVENT_TABLES[event_slug]) {
        return validationError(res, 'Invalid or missing event_slug');
      }

      const tableName = EVENT_TABLES[event_slug];

      // Fetch participants (students in participant role)
      const participantsResult = await pool.query(
        `SELECT 
          CASE 
            WHEN person_type = 'student' THEN student_id
            ELSE accompanist_id
          END AS person_id,
          person_type,
          full_name,
          phone,
          email
        FROM ${tableName}
        WHERE college_id = $1 AND event_type = 'PARTICIPANT'
        ORDER BY full_name`,
        [college_id]
      );

      // Fetch accompanists (in accompanying role)
      const accompanistsResult = await pool.query(
        `SELECT 
          CASE 
            WHEN person_type = 'student' THEN student_id
            ELSE accompanist_id
          END AS person_id,
          person_type,
          full_name,
          phone,
          email
        FROM ${tableName}
        WHERE college_id = $1 AND event_type = 'ACCOMPANIST'
        ORDER BY full_name`,
        [college_id]
      );

      // Fetch available students (approved but not assigned to this event)
      const availableStudentsResult = await pool.query(
        `SELECT 
          sa.student_id,
          s.full_name,
          s.usn,
          s.email,
          s.phone
        FROM student_applications sa
        INNER JOIN students s ON sa.student_id = s.id
        WHERE s.college_id = $1
          AND sa.status = 'APPROVED'
          AND sa.student_id NOT IN (
            SELECT student_id 
            FROM ${tableName}
            WHERE college_id = $1 
              AND person_type = 'student'
              AND student_id IS NOT NULL
          )
        ORDER BY s.full_name`,
        [college_id]
      );

      // Fetch available accompanists (not assigned to this event)
      const availableAccompanistsResult = await pool.query(
        `SELECT 
          id AS accompanist_id,
          full_name,
          phone,
          email,
          accompanist_type
        FROM accompanists
        WHERE college_id = $1
          AND id NOT IN (
            SELECT accompanist_id 
            FROM ${tableName}
            WHERE college_id = $1 
              AND person_type = 'accompanist'
              AND accompanist_id IS NOT NULL
          )
        ORDER BY full_name`,
        [college_id]
      );

      return success(res, {
        event_slug,
        participants: participantsResult.rows,
        accompanists: accompanistsResult.rows,
        available_students: availableStudentsResult.rows,
        available_accompanists: availableAccompanistsResult.rows,
      });
    }

    // ========================================================================
    // ACTION: add - Assign person to event
    // ========================================================================
    if (action === 'add') {
      const { event_slug, person_id, person_type, event_type } = req.body;

      // Validation
      if (!event_slug || !EVENT_TABLES[event_slug]) {
        return validationError(res, 'Invalid or missing event_slug');
      }

      if (!person_id || !person_type || !event_type) {
        return validationError(res, 'person_id, person_type, and event_type are required');
      }

      if (!['student', 'accompanist'].includes(person_type)) {
        return validationError(res, 'person_type must be "student" or "accompanist"');
      }

      if (!['PARTICIPANT', 'ACCOMPANIST'].includes(event_type)) {
        return validationError(res, 'event_type must be "PARTICIPANT" or "ACCOMPANIST"');
      }

      // Accompanists cannot be participants
      if (person_type === 'accompanist' && event_type === 'PARTICIPANT') {
        return validationError(res, 'Accompanists cannot be participants');
      }

      // Check college lock
      const lockCheck = await pool.query(
        'SELECT is_final_approved FROM colleges WHERE id = $1',
        [college_id]
      );

      if (lockCheck.rows[0].is_final_approved) {
        return error(res, 'College has final approval. Cannot modify assignments.', 403);
      }

      const tableName = EVENT_TABLES[event_slug];

      // Get college name and person details
      const collegeResult = await pool.query(
        'SELECT college_name FROM colleges WHERE id = $1',
        [college_id]
      );
      const college_name = collegeResult.rows[0].college_name;

      let full_name, phone, email;

      if (person_type === 'student') {
        // Check if student is approved
        const studentCheck = await pool.query(
          `SELECT sa.status, s.full_name, s.phone, s.email
           FROM student_applications sa
           INNER JOIN students s ON sa.student_id = s.id
           WHERE sa.student_id = $1 AND s.college_id = $2`,
          [person_id, college_id]
        );

        if (studentCheck.rows.length === 0) {
          return error(res, 'Student not found or does not belong to your college', 404);
        }

        if (studentCheck.rows[0].status !== 'APPROVED') {
          return error(res, 'Only approved students can be assigned to events', 403);
        }

        full_name = studentCheck.rows[0].full_name;
        phone = studentCheck.rows[0].phone;
        email = studentCheck.rows[0].email;

      } else {
        // Check if accompanist exists
        const accompCheck = await pool.query(
          'SELECT full_name, phone, email FROM accompanists WHERE id = $1 AND college_id = $2',
          [person_id, college_id]
        );

        if (accompCheck.rows.length === 0) {
          return error(res, 'Accompanist not found or does not belong to your college', 404);
        }

        full_name = accompCheck.rows[0].full_name;
        phone = accompCheck.rows[0].phone;
        email = accompCheck.rows[0].email;
      }

      // Check if already assigned
      const existingResult = await pool.query(
        `SELECT id FROM ${tableName} 
         WHERE college_id = $1 
           AND person_type = $2 
           AND ${person_type === 'student' ? 'student_id' : 'accompanist_id'} = $3`,
        [college_id, person_type, person_id]
      );

      if (existingResult.rows.length > 0) {
        return error(res, 'Person already assigned to this event', 409);
      }

      // Insert assignment
      const insertQuery = person_type === 'student'
        ? `INSERT INTO ${tableName} 
           (college_id, college_name, student_id, person_type, event_type, full_name, phone, email, created_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())`
        : `INSERT INTO ${tableName} 
           (college_id, college_name, accompanist_id, person_type, event_type, full_name, phone, email, created_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())`;

      await pool.query(insertQuery, [
        college_id,
        college_name,
        person_id,
        person_type,
        event_type,
        full_name,
        phone,
        email,
      ]);

      return success(res, null, 'Assignment added successfully', 201);
    }

    // ========================================================================
    // ACTION: remove - Unassign person from event
    // ========================================================================
    if (action === 'remove') {
      const { event_slug, person_id, person_type } = req.body;

      if (!event_slug || !EVENT_TABLES[event_slug]) {
        return validationError(res, 'Invalid or missing event_slug');
      }

      if (!person_id || !person_type) {
        return validationError(res, 'person_id and person_type are required');
      }

      // Check college lock
      const lockCheck = await pool.query(
        'SELECT is_final_approved FROM colleges WHERE id = $1',
        [college_id]
      );

      if (lockCheck.rows[0].is_final_approved) {
        return error(res, 'College has final approval. Cannot modify assignments.', 403);
      }

      const tableName = EVENT_TABLES[event_slug];
      const idColumn = person_type === 'student' ? 'student_id' : 'accompanist_id';

      const deleteResult = await pool.query(
        `DELETE FROM ${tableName} 
         WHERE college_id = $1 AND person_type = $2 AND ${idColumn} = $3`,
        [college_id, person_type, person_id]
      );

      if (deleteResult.rowCount === 0) {
        return error(res, 'Assignment not found', 404);
      }

      return success(res, null, 'Assignment removed successfully');
    }

    // Invalid action
    return validationError(res, 'Invalid action specified');

  } catch (err) {
    console.error('Assign events error:', err);
    return error(res, 'Failed to process event assignment', 500);
  }
});

module.exports = router;