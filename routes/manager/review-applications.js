// routes/manager/review-applications.js
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

  const { action } = req.body;

  const client = await pool.connect();

  try {
    if (action === 'list') {
      const applicationsResult = await client.query(
        `SELECT 
           sa.id AS application_id,
           sa.student_id,
           sa.status,
           sa.rejected_reason,
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
         ORDER BY sa.submitted_at DESC`,
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
          rejected_reason: app.rejected_reason,
          submitted_at: app.submitted_at,
          reviewed_at: app.reviewed_at,
          documents: documentsResult.rows,
        });
      }

      return res.status(200).json({
        success: true,
        applications,
      });
    }

    if (action === 'approve') {
      const { application_id } = req.body;

      if (!application_id) {
        return res.status(400).json({
          success: false,
          message: 'application_id is required',
        });
      }

      const lockResult = await client.query(
        `SELECT is_final_approved FROM colleges WHERE id = $1`,
        [college_id]
      );

      if (lockResult.rows.length === 0) {
        return res.status(400).json({
          success: false,
          message: 'Invalid college',
        });
      }

      if (lockResult.rows[0].is_final_approved === true) {
        return res.status(403).json({
          success: false,
          message: 'Final approval is locked. Cannot approve applications.',
        });
      }

      const appResult = await client.query(
        `SELECT sa.id, sa.status, s.college_id
         FROM student_applications sa
         INNER JOIN students s ON sa.student_id = s.id
         WHERE sa.id = $1`,
        [application_id]
      );

      if (appResult.rows.length === 0) {
        return res.status(404).json({
          success: false,
          message: 'Application not found',
        });
      }

      const application = appResult.rows[0];

      if (application.college_id !== college_id) {
        return res.status(403).json({
          success: false,
          message: 'Unauthorized',
        });
      }

      if (application.status !== 'PENDING') {
        return res.status(400).json({
          success: false,
          message: 'Only PENDING applications can be approved',
        });
      }

      await client.query(
        `UPDATE student_applications
         SET status = 'APPROVED', reviewed_at = NOW()
         WHERE id = $1`,
        [application_id]
      );

      return res.status(200).json({
        success: true,
        message: 'Application approved successfully',
      });
    }

    if (action === 'reject') {
      const { application_id, rejected_reason } = req.body;

      if (!application_id) {
        return res.status(400).json({
          success: false,
          message: 'application_id is required',
        });
      }

      const lockResult = await client.query(
        `SELECT is_final_approved FROM colleges WHERE id = $1`,
        [college_id]
      );

      if (lockResult.rows.length === 0) {
        return res.status(400).json({
          success: false,
          message: 'Invalid college',
        });
      }

      if (lockResult.rows[0].is_final_approved === true) {
        return res.status(403).json({
          success: false,
          message: 'Final approval is locked. Cannot reject applications.',
        });
      }

      const appResult = await client.query(
        `SELECT sa.id, sa.status, s.college_id
         FROM student_applications sa
         INNER JOIN students s ON sa.student_id = s.id
         WHERE sa.id = $1`,
        [application_id]
      );

      if (appResult.rows.length === 0) {
        return res.status(404).json({
          success: false,
          message: 'Application not found',
        });
      }

      const application = appResult.rows[0];

      if (application.college_id !== college_id) {
        return res.status(403).json({
          success: false,
          message: 'Unauthorized',
        });
      }

      if (application.status !== 'PENDING') {
        return res.status(400).json({
          success: false,
          message: 'Only PENDING applications can be rejected',
        });
      }

      await client.query(
        `UPDATE student_applications
         SET status = 'REJECTED', rejected_reason = $1, reviewed_at = NOW()
         WHERE id = $2`,
        [rejected_reason || null, application_id]
      );

      return res.status(200).json({
        success: true,
        message: 'Application rejected successfully',
      });
    }

    return res.status(400).json({
      success: false,
      message: 'Invalid action',
    });
  } catch (error) {
    console.error('Error in review-applications:', error);

    return res.status(500).json({
      success: false,
      message: 'An error occurred processing your request',
    });
  } finally {
    client.release();
  }
};