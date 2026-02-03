// routes/principal/pending-final-approval.js
const pool = require('../../db/pool');

module.exports = async (req, res) => {
  const user_id = req.user.id;
  const college_id = req.user.college_id;
  const role = req.user.role;

  if (!user_id || !college_id || role !== 'PRINCIPAL') {
    return res.status(403).json({
      success: false,
      message: 'Unauthorized',
    });
  }

  const client = await pool.connect();

  try {
    const applicationsResult = await client.query(
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
       ORDER BY sa.reviewed_at DESC`,
      [college_id]
    );

    const applications = [];

    for (const app of applicationsResult.rows) {
      const documentsResult = await client.query(
        `SELECT document_type, document_url
         FROM application_documents
         WHERE application_id = $1`,
        [app.application_id]
      );

      applications.push({
        application_id: app.application_id,
        student_id: app.student_id,
        usn: app.usn,
        full_name: app.full_name,
        email: app.email,
        phone: app.phone,
        gender: app.gender,
        passport_photo_url: app.passport_photo_url,
        status: app.status,
        submitted_at: app.submitted_at,
        reviewed_at: app.reviewed_at,
        documents: documentsResult.rows,
      });
    }

    return res.status(200).json({
      success: true,
      applications,
    });
  } catch (error) {
    console.error('Error in pending-final-approval:', error);

    return res.status(500).json({
      success: false,
      message: 'An error occurred processing your request',
    });
  } finally {
    client.release();
  }
};