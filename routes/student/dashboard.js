// routes/student/dashboard.js
const pool = require('../../db/pool');

module.exports = async (req, res) => {
  // ✅ FIX: Check if req.user exists BEFORE accessing properties
  if (!req.user || !req.user.student_id) {
    return res.status(401).json({
      success: false,
      message: 'Token expired. Redirecting to login...',
      redirect: 'https://vtufest2026.acharyahabba.com/',
    });
  }

  const student_id = req.user.student_id;

  const client = await pool.connect();

  try {
    const studentResult = await client.query(
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
      return res.status(404).json({
        success: false,
        message: 'Student not found',
      });
    }

    const studentData = studentResult.rows[0];

    let applicationData = null;
    let documents = [];

    const applicationResult = await client.query(
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

      const documentsResult = await client.query(
        `SELECT
           document_type,
           document_url
         FROM application_documents
         WHERE application_id = $1`,
        [app.id]
      );

      documents = documentsResult.rows;
    }

    let qrCode = null;

    const qrResult = await client.query(
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

    const response = {
      success: true,
      data: {
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
      },
    };

    return res.status(200).json(response);
  } catch (error) {
    console.error('Dashboard API error:', error);

    return res.status(500).json({
      success: false,
      message: 'Failed to load dashboard data. Please refresh the page.',
      autoRetry: true,
    });
  } finally {
    client.release();
  }
};