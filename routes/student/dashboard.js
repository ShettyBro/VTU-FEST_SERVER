// routes/student/dashboard.js
const express = require('express');
const router = express.Router();
const pool = require('../../db/pool');
const { authenticate } = require('../../middleware/auth');
const requireRole = require('../../middleware/requireRole');
const { success, error } = require('../../utils/response');

// ============================================================================
// POST /api/student/dashboard
// Get student dashboard data (application status, documents, QR code)
// ============================================================================
router.post('/', authenticate, requireRole(['STUDENT']), async (req, res) => {
  try {
    // ✅ Use req.user.student_id set by auth middleware
    const student_id = req.user.student_id;

    // Fetch student details
    const studentResult = await pool.query(
      `SELECT 
         id,
         usn,
         full_name,
         college_id,
         email,
         phone,
         reapply_count
       FROM students
       WHERE id = $1`,
      [student_id]
    );

    if (studentResult.rows.length === 0) {
      return error(res, 'Student not found', 404);
    }

    const studentData = studentResult.rows[0];

    // Fetch application data
    let applicationData = null;
    let documents = [];

    const applicationResult = await pool.query(
      `SELECT
         id,
         status,
         rejected_reason,
         submitted_at
       FROM student_applications
       WHERE student_id = $1
       ORDER BY id DESC
       LIMIT 1`,
      [student_id]
    );

    if (applicationResult.rows.length > 0) {
      const app = applicationResult.rows[0];
      applicationData = {
        id: app.id,
        status: app.status,
        rejected_reason: app.rejected_reason,
        submitted_at: app.submitted_at,
      };

      // Fetch application documents
      const documentsResult = await pool.query(
        `SELECT
           document_type,
           document_url
         FROM application_documents
         WHERE application_id = $1`,
        [app.id]
      );

      documents = documentsResult.rows;
    }

    // Fetch QR code (if final approval done)
    let qrCode = null;

    const qrResult = await pool.query(
      `SELECT qr_code
       FROM final_event_participants_master
       WHERE student_id = $1
         AND person_type = 'STUDENT'
         AND qr_code IS NOT NULL
       LIMIT 1`,
      [student_id]
    );

    if (qrResult.rows.length > 0 && qrResult.rows[0].qr_code) {
      qrCode = qrResult.rows[0].qr_code;
    }

    // Build response
    return success(res, {
      student: {
        id: studentData.id,
        usn: studentData.usn,
        full_name: studentData.full_name,
        college_id: studentData.college_id,
        email: studentData.email,
        phone: studentData.phone,
      },
      application: applicationData,
      documents: documents,
      reapply_count: studentData.reapply_count,
      qr_code: qrCode,
    });

  } catch (err) {
    console.error('Student dashboard error:', err);
    return error(res, 'Failed to load dashboard data', 500);
  }
});

module.exports = router;