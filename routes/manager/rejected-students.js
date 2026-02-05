const express = require('express');
const router = express.Router();
const pool = require('../../db/pool');
const { authenticate } = require('../../middleware/auth');
const requireRole = require('../../middleware/requireRole');
const { success, error } = require('../../utils/response');

router.use(authenticate);
router.use(requireRole(['MANAGER', 'PRINCIPAL']));

router.post('/', async (req, res) => {
  try {
    const { college_id } = req.user;

    const result = await pool.query(
      `SELECT 
        sa.student_id,
        s.full_name,
        s.usn,
        s.email,
        s.phone,
        sa.rejected_reason,
        sa.reviewed_at,
        s.reapply_count
      FROM student_applications sa
      INNER JOIN students s ON sa.student_id = s.id
      WHERE s.college_id = $1
        AND sa.status = 'REJECTED'
      ORDER BY sa.reviewed_at DESC`,
      [college_id]
    );

    return res.status(200).json({
      success: true,
      students: result.rows
    });

  } catch (err) {
    console.error('Rejected students error:', err);
    return error(res, 'Failed to fetch rejected students', 500);
  }
});

module.exports = router;