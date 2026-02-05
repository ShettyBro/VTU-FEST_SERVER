const express = require('express');
const router = express.Router();
const pool = require('../../db/pool');
const { authenticate } = require('../../middleware/auth');
const requireRole = require('../../middleware/requireRole');
const { success, error, validationError } = require('../../utils/response');

router.use(authenticate);
router.use(requireRole(['MANAGER', 'PRINCIPAL']));

router.post('/', async (req, res) => {
  const { action } = req.body;
  const { college_id, id: user_id } = req.user;

  try {
    if (action === 'list' || !action) {
      const result = await pool.query(
        `SELECT 
          sa.id AS application_id,
          sa.student_id,
          s.full_name,
          s.usn,
          s.email,
          s.phone,
          s.gender,
          sa.blood_group,
          sa.address,
          sa.department,
          sa.year_of_study,
          sa.semester,
          sa.status
        FROM student_applications sa
        INNER JOIN students s ON sa.student_id = s.id
        WHERE s.college_id = $1
          AND sa.status = 'APPROVED'
        ORDER BY s.full_name ASC`,
        [college_id]
      );

      return success(res, { students: result.rows });
    }

    if (action === 'edit_approved_student_details') {
      const lockCheck = await pool.query(
        'SELECT is_final_approved FROM colleges WHERE id = $1',
        [college_id]
      );

      if (lockCheck.rows[0]?.is_final_approved) {
        return error(res, 'Final approval is locked. Cannot edit students.', 403);
      }

      const {
        student_id,
        full_name,
        email,
        phone,
        gender,
        blood_group,
        address,
        department,
        year_of_study,
        semester
      } = req.body;

      if (!student_id) {
        return validationError(res, 'student_id is required');
      }

      const client = await pool.connect();
      try {
        await client.query('BEGIN');

        await client.query(
          `UPDATE students
           SET full_name = $1, email = $2, phone = $3, gender = $4
           WHERE id = $5`,
          [full_name, email, phone, gender, student_id]
        );

        await client.query(
          `UPDATE student_applications
           SET blood_group = $1, address = $2, department = $3, year_of_study = $4, semester = $5
           WHERE student_id = $6`,
          [blood_group, address, department, year_of_study, semester, student_id]
        );

        await client.query('COMMIT');
        return success(res, { message: 'Student details updated successfully' });

      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      } finally {
        client.release();
      }
    }

    if (action === 'move_to_rejected') {
      const lockCheck = await pool.query(
        'SELECT is_final_approved FROM colleges WHERE id = $1',
        [college_id]
      );

      if (lockCheck.rows[0]?.is_final_approved) {
        return error(res, 'Final approval is locked. Cannot reject students.', 403);
      }

      const { student_id, rejection_reason } = req.body;

      if (!student_id || !rejection_reason) {
        return validationError(res, 'student_id and rejection_reason are required');
      }

      await pool.query(
        `UPDATE student_applications
         SET status = 'REJECTED', rejected_reason = $1, reviewed_at = NOW()
         WHERE student_id = $2`,
        [rejection_reason, student_id]
      );

      await pool.query(
        `UPDATE students
         SET reapply_count = reapply_count + 1
         WHERE id = $1`,
        [student_id]
      );

      return success(res, { message: 'Student moved to rejected successfully' });
    }

    return validationError(res, 'Invalid action');

  } catch (err) {
    console.error('Approved students error:', err);
    return error(res, 'Failed to process request', 500);
  }
});

module.exports = router;