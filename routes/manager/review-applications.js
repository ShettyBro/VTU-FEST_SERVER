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
      // ✅ OPTIMIZATION: Fetch applications and documents in a SINGLE JOIN query
      const result = await client.query(
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
           s.passport_photo_url,
           ad.document_type,
           ad.document_url
         FROM student_applications sa
         INNER JOIN students s ON sa.student_id = s.id
         LEFT JOIN application_documents ad ON sa.id = ad.application_id
         WHERE s.college_id = $1
         ORDER BY sa.submitted_at DESC, sa.id, ad.id`,
        [college_id]
      );

      // ✅ Group documents by application_id
      const applicationsMap = new Map();

      for (const row of result.rows) {
        const appId = row.application_id;

        // Initialize application if not exists
        if (!applicationsMap.has(appId)) {
          applicationsMap.set(appId, {
            application_id: appId,
            student_id: row.student_id,
            usn: row.usn,
            full_name: row.full_name,
            email: row.email,
            phone: row.phone,
            gender: row.gender,
            passport_photo_url: row.passport_photo_url,
            status: row.status,
            rejected_reason: row.rejected_reason,
            submitted_at: row.submitted_at,
            reviewed_at: row.reviewed_at,
            documents: [],
          });
        }

        // Add document if exists (LEFT JOIN may have nulls)
        if (row.document_type && row.document_url) {
          applicationsMap.get(appId).documents.push({
            document_type: row.document_type,
            document_url: row.document_url,
          });
        }
      }

      // Convert Map to array
      const applications = Array.from(applicationsMap.values());

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