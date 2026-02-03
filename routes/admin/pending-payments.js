// routes/admin/pending-payments.js
const pool = require('../../db/pool');

module.exports = async (req, res) => {
  const user_id = req.user.id;
  const role = req.user.role;

  if (!user_id || role !== 'ADMIN') {
    return res.status(403).json({
      success: false,
      message: 'Unauthorized',
    });
  }

  const client = await pool.connect();

  try {
    const paymentsResult = await client.query(
      `SELECT 
         pr.id AS receipt_id,
         pr.college_id,
         c.college_name,
         c.college_code,
         pr.receipt_url,
         pr.amount_paid,
         pr.utr_reference_number,
         pr.uploaded_by_name,
         pr.uploaded_by_type,
         pr.uploaded_at,
         pr.status
       FROM payment_receipts pr
       INNER JOIN colleges c ON pr.college_id = c.id
       WHERE pr.status = 'PENDING'
       ORDER BY pr.uploaded_at ASC`
    );

    return res.status(200).json({
      success: true,
      payments: paymentsResult.rows,
    });
  } catch (error) {
    console.error('Error in pending-payments:', error);

    return res.status(500).json({
      success: false,
      message: 'An error occurred processing your request',
    });
  } finally {
    client.release();
  }
};