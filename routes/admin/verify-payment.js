// routes/admin/verify-payment.js
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

  const { receipt_id, action, admin_remarks } = req.body;

  if (!receipt_id) {
    return res.status(400).json({
      success: false,
      message: 'receipt_id is required',
    });
  }

  if (!action || (action !== 'approve' && action !== 'reject')) {
    return res.status(400).json({
      success: false,
      message: 'action must be either "approve" or "reject"',
    });
  }

  const client = await pool.connect();

  try {
    const paymentResult = await client.query(
      `SELECT id, status
       FROM payment_receipts
       WHERE id = $1`,
      [receipt_id]
    );

    if (paymentResult.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Payment receipt not found',
      });
    }

    const payment = paymentResult.rows[0];

    if (payment.status !== 'PENDING') {
      return res.status(400).json({
        success: false,
        message: 'Only PENDING payments can be verified',
      });
    }

    const newStatus = action === 'approve' ? 'APPROVED' : 'REJECTED';

    await client.query(
      `UPDATE payment_receipts
       SET status = $1,
           admin_remarks = $2,
           verified_by = $3,
           verified_at = NOW()
       WHERE id = $4`,
      [newStatus, admin_remarks || null, user_id, receipt_id]
    );

    return res.status(200).json({
      success: true,
      message: `Payment ${action === 'approve' ? 'approved' : 'rejected'} successfully`,
    });
  } catch (error) {
    console.error('Error in verify-payment:', error);

    return res.status(500).json({
      success: false,
      message: 'An error occurred processing your request',
    });
  } finally {
    client.release();
  }
};