// routes/auth/login.js
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const pool = require('../../db/pool');

const JWT_SECRET = process.env.JWT_SECRET;

// Valid roles mapping (frontend -> backend)
const VALID_ROLES = {
  student: 'STUDENT',
  principal: 'PRINCIPAL',
  manager: 'MANAGER',
  admin: 'ADMIN',
  sub_admin: 'SUB_ADMIN',
  volunteer_registration: 'VOLUNTEER_REGISTRATION',
  volunteer_helpdesk: 'VOLUNTEER_HELPDESK',
  volunteer_event: 'VOLUNTEER_EVENT',
};

// ============================================
// STUDENT LOGIN HANDLER
// ============================================
async function handleStudentLogin(email, password) {
  const result = await pool.query(
    "SELECT * FROM students WHERE email = $1",
    [email]
  );

  if (result.rows.length === 0) {
    return {
      statusCode: 401,
      data: { message: "Invalid Email or Password" },
    };
  }

  const student = result.rows[0];

  // Check if account is active
  if (!student.is_active) {
    return {
      statusCode: 403,
      data: { message: "Account is inactive" },
    };
  }

  // Verify password
  const isMatch = await bcrypt.compare(password, student.password_hash);

  if (!isMatch) {
    return {
      statusCode: 401,
      data: { message: "Invalid Email or Password" },
    };
  }

  // Generate JWT token
  const token = jwt.sign(
    {
      student_id: student.id,
      usn: student.usn,
      college_id: student.college_id,
      role: "STUDENT",
    },
    JWT_SECRET,
    { expiresIn: "4h" }
  );

  // Update last login
  await pool.query(
    "UPDATE students SET last_login_at = NOW() WHERE id = $1",
    [student.id]
  );

  return {
    statusCode: 200,
    data: {
      message: "Login successful",
      token,
      role: "student",
      college_id: student.college_id,
      usn: student.usn,
      name: student.full_name,
    },
  };
}

// ============================================
// USER LOGIN HANDLER (Principal, Manager, Admin, Volunteers)
// ============================================
async function handleUserLogin(email, password, expectedRole) {
  const result = await pool.query(
    "SELECT * FROM users WHERE email = $1 AND role = $2",
    [email, expectedRole]
  );

  if (result.rows.length === 0) {
    return {
      statusCode: 401,
      data: { message: "Invalid Email or Password" },
    };
  }

  const user = result.rows[0];

  // Check if account is active
  if (!user.is_active) {
    return {
      statusCode: 403,
      data: { message: "Account is inactive" },
    };
  }

  // Verify password
  const isMatch = await bcrypt.compare(password, user.password_hash);

  if (!isMatch) {
    return {
      statusCode: 401,
      data: { message: "Invalid Email or Password" },
    };
  }

  // ⚠️ CRITICAL: Check if force_password_reset flag is set
  // This triggers mandatory password reset on first login or when admin forces it
  if (user.force_password_reset === true) {
    // Generate a special 15-minute token for forced password reset
    const resetToken = crypto.randomBytes(32).toString('hex');
    const hashedResetToken = await bcrypt.hash(resetToken, 10);
    const expiryTime = new Date(Date.now() + 15 * 60 * 1000); // 15 minutes

    // Store reset token in database
    await pool.query(
      `UPDATE users
       SET password_reset_token = $1,
           password_reset_expires = $2
       WHERE id = $3`,
      [hashedResetToken, expiryTime, user.id]
    );

    // ⚠️ DO NOT generate JWT session token
    // Return FORCE_RESET status with reset token for frontend redirect
    return {
      statusCode: 200,
      data: {
        status: "FORCE_RESET",
        message: "First-time login detected. Please reset your password.",
        reset_token: resetToken,
        email: user.email,
        role: expectedRole.toLowerCase().replace(/_/g, '_'),
      },
    };
  }

  // ✅ Normal login flow continues (force_password_reset is false)
  
  // Generate JWT token payload
  const tokenPayload = {
    user_id: user.id,
    full_name: user.full_name,
    role: expectedRole,
  };

  // Add college_id only for PRINCIPAL and MANAGER
  if (expectedRole === 'PRINCIPAL' || expectedRole === 'MANAGER') {
    tokenPayload.college_id = user.college_id;
  }

  // Generate JWT token
  const token = jwt.sign(tokenPayload, JWT_SECRET, { expiresIn: "4h" });

  // Update last login timestamp
  await pool.query(
    "UPDATE users SET last_login_at = NOW() WHERE id = $1",
    [user.id]
  );

  // Prepare response data
  const responseData = {
    message: "Login successful",
    token,
    role: expectedRole.toLowerCase().replace(/_/g, '_'),
    name: user.full_name,
    user_id: user.id,
  };

  // Add college_id to response for PRINCIPAL and MANAGER
  if (user.college_id) {
    responseData.college_id = user.college_id;
  }

  return {
    statusCode: 200,
    data: responseData,
  };
}

// ============================================
// EXPRESS ROUTE HANDLER
// ============================================
module.exports = async (req, res) => {
  const { email, password, role } = req.body;

  // Validate required fields
  if (!email || !password || !role) {
    return res.status(400).json({ message: "Email, password, and role are required" });
  }

  // Validate role
  const normalizedRole = VALID_ROLES[role.toLowerCase()];
  if (!normalizedRole) {
    return res.status(400).json({ message: "Invalid role specified" });
  }

  try {
    // Route to appropriate login handler based on role
    let result;
    if (normalizedRole === 'STUDENT') {
      result = await handleStudentLogin(email, password);
    } else {
      result = await handleUserLogin(email, password, normalizedRole);
    }

    return res.status(result.statusCode).json(result.data);
  } catch (err) {
    console.error("Login error:", err);
    return res.status(500).json({ message: "Server Re-booting.. try 1 min later" });
  }
};