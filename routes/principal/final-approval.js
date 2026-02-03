// routes/principal/final-approval.js
const pool = require('../../db/pool');

module.exports = async (req, res) => {
  const principal_user_id = req.user.id;
  const college_id = req.user.college_id;
  const role = req.user.role;

  if (!principal_user_id || !college_id || role !== 'PRINCIPAL') {
    return res.status(403).json({
      success: false,
      message: 'Unauthorized: Only PRINCIPAL can perform final approval',
    });
  }

  const client = await pool.connect();

  try {
    await client.query('BEGIN ISOLATION LEVEL SERIALIZABLE');

    const lockResult = await client.query(
      `SELECT is_final_approved 
       FROM colleges 
       WHERE id = $1 
       FOR UPDATE`,
      [college_id]
    );

    if (lockResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({
        success: false,
        message: 'College not found',
      });
    }

    if (lockResult.rows[0].is_final_approved === true) {
      await client.query('ROLLBACK');
      return res.status(403).json({
        success: false,
        message: 'Final approval already submitted',
      });
    }

    const studentsResult = await client.query(
      `SELECT 
         s.id,
         s.full_name,
         s.phone,
         s.email,
         s.passport_photo_url
       FROM students s
       INNER JOIN student_applications sa ON s.id = sa.student_id
       WHERE s.college_id = $1
         AND sa.status = 'APPROVED'`,
      [college_id]
    );

    const approvedStudents = studentsResult.rows;

    if (approvedStudents.length === 0) {
      await client.query('ROLLBACK');
      return res.status(400).json({
        success: false,
        message: 'No approved students found for final approval',
      });
    }

    const qrReserveResult = await client.query(
      `SELECT id, qr_code 
       FROM qr_code_pool 
       WHERE is_used = false 
       ORDER BY id
       FOR UPDATE SKIP LOCKED 
       LIMIT $1`,
      [approvedStudents.length]
    );

    const reserved_qr_codes = qrReserveResult.rows;

    if (reserved_qr_codes.length < approvedStudents.length) {
      await client.query('ROLLBACK');
      return res.status(500).json({
        success: false,
        message: 'QR code pool exhausted. Cannot complete final approval.',
        details: `Need ${approvedStudents.length} QR codes, but only ${reserved_qr_codes.length} available.`,
      });
    }

    let qr_index = 0;
    let inserted_students = 0;
    const qr_pool_ids = [];

    for (const student of approvedStudents) {
      const { id: qr_pool_id, qr_code } = reserved_qr_codes[qr_index++];

      const insertResult = await client.query(
        `INSERT INTO final_event_participants_master (
           college_id,
           person_type,
           student_id,
           accompanist_id,
           name,
           phone,
           email,
           passport_photo_url,
           id_proof_url,
           qr_code,
           qr_assigned_at
         )
         VALUES ($1, 'STUDENT', $2, NULL, $3, $4, $5, $6, NULL, $7, NOW())
         RETURNING id`,
        [
          college_id,
          student.id,
          student.full_name,
          student.phone,
          student.email,
          student.passport_photo_url,
          qr_code
        ]
      );

      const participant_id = insertResult.rows[0].id;
      qr_pool_ids.push({ pool_id: qr_pool_id, participant_id });

      inserted_students++;
    }

    if (qr_pool_ids.length > 0) {
      const poolIds = qr_pool_ids.map(q => q.pool_id);
      const caseStatements = qr_pool_ids
        .map(q => `WHEN ${q.pool_id} THEN ${q.participant_id}`)
        .join(' ');

      await client.query(
        `UPDATE qr_code_pool 
         SET 
           is_used = true, 
           assigned_to_person_id = CASE id ${caseStatements} END
         WHERE id = ANY($1::int[])`,
        [poolIds]
      );
    }

    await client.query(
      `UPDATE colleges 
       SET 
         is_final_approved = true,
         final_approved_at = NOW(),
         final_approved_by = $1
       WHERE id = $2`,
      [principal_user_id, college_id]
    );

    await client.query('COMMIT');

    return res.status(200).json({
      success: true,
      message: 'Final approval successful. All registrations are now locked.',
      data: {
        inserted_students,
        total_participants: inserted_students
      }
    });

  } catch (error) {
    await client.query('ROLLBACK');

    if (error.code === '40001') {
      return res.status(409).json({
        success: false,
        message: 'Concurrent transaction conflict. Please retry.',
        details: 'Another transaction modified the same data. Try again.'
      });
    }

    console.error('Final approval error:', error);

    return res.status(500).json({
      success: false,
      message: 'Internal server error during final approval',
      details: error.message
    });

  } finally {
    client.release();
  }
};