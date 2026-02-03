// routes/manager/approved-students.js
const pool = require('../../db/pool');

module.exports = async (req, res) => {
  const user_id = req.user.id;
  const college_id = req.user.college_id;
  const role = req.user.role;

  if (!user_id || !college_id || role !== 'MANAGER') {
    return res.status(403).json({
      success: false,
      message: 'Unauthorized',
    });
  }

  const client = await pool.connect();

  try {
    const studentsResult = await client.query(
      `SELECT 
         sa.id AS application_id,
         sa.student_id,
         sa.status,
         sa.submitted_at,
         sa.reviewed_at,
         s.usn,
         s.full_name,
         s.email,
         s.phone,
         s.gender,
         s.passport_photo_url
       FROM student_applications sa
       INNER JOIN students s ON sa.student_id = s.id
       WHERE s.college_id = $1
         AND sa.status = 'APPROVED'
       ORDER BY s.full_name ASC`,
      [college_id]
    );

    const students = [];

    for (const student of studentsResult.rows) {
      const documentsResult = await client.query(
        `SELECT document_type, document_url
         FROM application_documents
         WHERE application_id = $1`,
        [student.application_id]
      );

      students.push({
        application_id: student.application_id,
        student_id: student.student_id,
        usn: student.usn,
        full_name: student.full_name,
        email: student.email,
        phone: student.phone,
        gender: student.gender,
        passport_photo_url: student.passport_photo_url,
        status: student.status,
        submitted_at: student.submitted_at,
        reviewed_at: student.reviewed_at,
        documents: documentsResult.rows,
      });
    }

    return res.status(200).json({
      success: true,
      students,
    });
  } catch (error) {
    console.error('Error in approved-students:', error);

    return res.status(500).json({
      success: false,
      message: 'An error occurred processing your request',
    });
  } finally {
    client.release();
  }
};