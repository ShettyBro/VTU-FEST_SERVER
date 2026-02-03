const express = require('express');
const router = express.Router();
const pool = require('../../db/pool');
const { success, error, validationError } = require('../../utils/response');

// ============================================================================
// GET /api/shared/college-and-usn/colleges
// Public endpoint - Returns list of all active colleges
// ============================================================================
router.get('/colleges', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT 
        id,
        college_name,
        college_code,
        place
      FROM colleges
      WHERE is_active = true
      ORDER BY college_name ASC
    `);

    return success(res, { colleges: result.rows });

  } catch (err) {
    console.error('Error fetching colleges:', err);
    return error(res, 'Failed to fetch colleges', 500);
  }
});

// ============================================================================
// POST /api/shared/college-and-usn/check-usn
// Public endpoint - Check if USN already exists in system
// ============================================================================
router.post('/check-usn', async (req, res) => {
  try {
    const { usn } = req.body;

    // Validate USN
    if (!usn || typeof usn !== 'string' || !usn.trim()) {
      return validationError(res, 'USN is required');
    }

    // Normalize USN (trim and uppercase)
    const normalizedUSN = usn.trim().toUpperCase();

    // Check if USN exists
    const result = await pool.query(
      'SELECT id FROM students WHERE usn = $1',
      [normalizedUSN]
    );

    return success(res, { exists: result.rows.length > 0 });

  } catch (err) {
    console.error('Error checking USN:', err);
    return error(res, 'Failed to check USN', 500);
  }
});

module.exports = router;