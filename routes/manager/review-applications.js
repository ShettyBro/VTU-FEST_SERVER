const express = require('express');
const router = express.Router();
const pool = require('../../db/pool');
const { authenticate } = require('../../middleware/auth');
const requireRole = require('../../middleware/requireRole');
const checkCollegeLock = require('../../middleware/checkCollegeLock');
const { success, error, validationError } = require('../../utils/response');

router.use(authenticate);
router.use(requireRole(['MANAGER', 'PRINCIPAL']));

router.post('/', async (req, res) => {
  const { action } = req.body;
  const { college_id, id: user_id } = req.user;

  if (!action) {
    return validationError(res, 'action is required');
  }

  try {
    if (action === 'list') {
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
          sa.status,
          sa.submitted_at
        FROM student_applications sa
        INNER JOIN students s ON sa.student_id = s.id
        WHERE s.college_id = $1
          AND sa.status = 'SUBMITTED'
        ORDER BY sa.submitted_at DESC`,
        [college_id]
      );

      const applications = [];

      for (const app of result.rows) {
        const docsResult = await pool.query(
          `SELECT document_type, document_url
           FROM application_documents
           WHERE application_id = $1`,
          [app.application_id]
        );

        const documents = {};
        docsResult.rows.forEach(doc => {
          documents[doc.document_type.toLowerCase()] = doc.document_url;
        });

        applications.push({
          application_id: app.application_id,
          student_id: app.student_id,
          full_name: app.full_name,
          usn: app.usn,
          email: app.email,
          phone: app.phone,
          gender: app.gender,
          blood_group: app.blood_group,
          address: app.address,
          department: app.department,
          year_of_study: app.year_of_study,
          semester: app.semester,
          status: app.status,
          submitted_at: app.submitted_at,
          documents,
        });
      }

      return res.status(200).json({
        success: true,
        applications
      });
    }

    if (action === 'approve_student') {
      const lockCheck = await pool.query(
        'SELECT is_final_approved FROM colleges WHERE id = $1',
        [college_id]
      );

      if (lockCheck.rows[0]?.is_final_approved) {
        return error(res, 'Final approval is locked. Cannot approve students.', 403);
      }

      const { application_id, participating_events, accompanying_events } = req.body;

      if (!application_id) {
        return validationError(res, 'application_id is required');
      }

      if (!participating_events || !Array.isArray(participating_events)) {
        return validationError(res, 'participating_events must be an array');
      }

      const client = await pool.connect();
      try {
        await client.query('BEGIN');

        const appResult = await client.query(
          'SELECT student_id, status FROM student_applications WHERE id = $1',
          [application_id]
        );

        if (appResult.rows.length === 0) {
          await client.query('ROLLBACK');
          return error(res, 'Application not found', 404);
        }

        const student_id = appResult.rows[0].student_id;

        const quotaCheck = await client.query(
          `SELECT 
            (SELECT COUNT(DISTINCT sa.student_id)
             FROM student_applications sa
             INNER JOIN students s ON sa.student_id = s.id
             WHERE s.college_id = $1 AND sa.status = 'APPROVED') +
            (SELECT COUNT(*)
             FROM accompanists
             WHERE college_id = $1) AS quota_used`,
          [college_id]
        );

        const quota_used = parseInt(quotaCheck.rows[0].quota_used);

        if (quota_used >= 45) {
          await client.query('ROLLBACK');
          return error(res, 'College quota exceeded (45/45). Remove existing participants before adding new ones.', 403);
        }

        await client.query(
          `UPDATE student_applications
           SET status = 'APPROVED', reviewed_at = NOW(), rejected_reason = NULL
           WHERE id = $1`,
          [application_id]
        );

        await client.query('COMMIT');
        return success(res, { message: 'Student approved successfully' });

      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      } finally {
        client.release();
      }
    }

    if (action === 'reject_student') {
      const lockCheck = await pool.query(
        'SELECT is_final_approved FROM colleges WHERE id = $1',
        [college_id]
      );

      if (lockCheck.rows[0]?.is_final_approved) {
        return error(res, 'Final approval is locked. Cannot reject students.', 403);
      }

      const { application_id, rejection_reason } = req.body;

      if (!application_id || !rejection_reason) {
        return validationError(res, 'application_id and rejection_reason are required');
      }

      const appResult = await pool.query(
        'SELECT student_id FROM student_applications WHERE id = $1',
        [application_id]
      );

      if (appResult.rows.length === 0) {
        return error(res, 'Application not found', 404);
      }

      const student_id = appResult.rows[0].student_id;

      await pool.query(
        `UPDATE student_applications
         SET status = 'REJECTED', rejected_reason = $1, reviewed_at = NOW()
         WHERE id = $2`,
        [rejection_reason, application_id]
      );

      await pool.query(
        `UPDATE students
         SET reapply_count = reapply_count + 1
         WHERE id = $1`,
        [student_id]
      );

      return success(res, { message: 'Student rejected successfully' });
    }

    if (action === 'edit_student_details') {
      const lockCheck = await pool.query(
        'SELECT is_final_approved FROM colleges WHERE id = $1',
        [college_id]
      );

      if (lockCheck.rows[0]?.is_final_approved) {
        return error(res, 'Final approval is locked. Cannot edit students.', 403);
      }

      const {
        application_id,
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

      if (!application_id) {
        return validationError(res, 'application_id is required');
      }

      const client = await pool.connect();
      try {
        await client.query('BEGIN');

        const appResult = await client.query(
          'SELECT student_id FROM student_applications WHERE id = $1',
          [application_id]
        );

        if (appResult.rows.length === 0) {
          await client.query('ROLLBACK');
          return error(res, 'Application not found', 404);
        }

        const student_id = appResult.rows[0].student_id;

        await client.query(
          `UPDATE students
           SET full_name = $1, email = $2, phone = $3, gender = $4
           WHERE id = $5`,
          [full_name, email, phone, gender, student_id]
        );

        await client.query(
          `UPDATE student_applications
           SET blood_group = $1, address = $2, department = $3, year_of_study = $4, semester = $5
           WHERE id = $6`,
          [blood_group, address, department, year_of_study, semester, application_id]
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

    return validationError(res, 'Invalid action');

  } catch (err) {
    console.error('Review applications error:', err);
    return error(res, 'Failed to process request', 500);
  }
});

module.exports = router;