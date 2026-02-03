const express = require('express');
const router = express.Router();
const pool = require('../../db/pool');
const { authenticate } = require('../../middleware/auth');
const requireRole = require('../../middleware/requireRole');
const { success, error, validationError } = require('../../utils/response');

// ============================================================================
// POST /api/manager/accommodation
// Multi-action endpoint for accommodation management
// ============================================================================
router.post('/', authenticate, requireRole(['MANAGER', 'PRINCIPAL']), async (req, res) => {
  const { action } = req.body;
  const { college_id, id: user_id, role } = req.user;

  if (!action) {
    return validationError(res, 'Action is required');
  }

  try {
    // ========================================================================
    // ACTION: get_accommodation_status - Get existing accommodation request
    // ========================================================================
    if (action === 'get_accommodation_status') {
      const result = await pool.query(
        `SELECT 
          total_boys,
          total_girls,
          contact_person_name,
          contact_person_phone,
          special_requirements,
          status,
          applied_at,
          admin_remarks
        FROM accommodation_requests
        WHERE college_id = $1`,
        [college_id]
      );

      if (result.rows.length === 0) {
        return success(res, { accommodation: null });
      }

      return success(res, { accommodation: result.rows[0] });
    }

    // ========================================================================
    // ACTION: submit_accommodation - Submit accommodation request (ONE-TIME)
    // ========================================================================
    if (action === 'submit_accommodation') {
      const {
        total_boys,
        total_girls,
        contact_person_name,
        contact_person_phone,
        special_requirements,
      } = req.body;

      // Validate required fields
      if (!total_boys || !total_girls || !contact_person_name || !contact_person_phone) {
        return validationError(res, 'All required fields must be filled: total_boys, total_girls, contact_person_name, contact_person_phone');
      }

      // Validate numbers
      const boysCount = parseInt(total_boys);
      const girlsCount = parseInt(total_girls);

      if (isNaN(boysCount) || isNaN(girlsCount) || boysCount < 0 || girlsCount < 0) {
        return validationError(res, 'total_boys and total_girls must be valid non-negative numbers');
      }

      // STRICT: Check if accommodation already exists for this college
      const existingResult = await pool.query(
        'SELECT id FROM accommodation_requests WHERE college_id = $1',
        [college_id]
      );

      if (existingResult.rows.length > 0) {
        return error(
          res,
          'Accommodation request already submitted for this college. Re-application is not allowed.',
          403
        );
      }

      // Validate phone number (basic check)
      const phoneRegex = /^[0-9]{10}$/;
      if (!phoneRegex.test(contact_person_phone)) {
        return validationError(res, 'Contact phone must be a valid 10-digit number');
      }

      // Insert accommodation request
      await pool.query(
        `INSERT INTO accommodation_requests (
          college_id,
          total_boys,
          total_girls,
          contact_person_name,
          contact_person_phone,
          special_requirements,
          applied_by_user_id,
          applied_by_role,
          applied_by_type,
          status,
          applied_at
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'PENDING', NOW())`,
        [
          college_id,
          boysCount,
          girlsCount,
          contact_person_name.trim(),
          contact_person_phone.trim(),
          special_requirements ? special_requirements.trim() : null,
          user_id,
          role,
          role, // applied_by_type same as role
        ]
      );

      return success(
        res,
        null,
        'Accommodation request submitted successfully',
        201
      );
    }

    // Invalid action
    return validationError(res, 'Invalid action specified');

  } catch (err) {
    console.error('Accommodation error:', err);
    return error(res, 'Failed to process accommodation request', 500);
  }
});

module.exports = router;