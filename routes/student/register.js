// routes/student/register.js
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const pool = require('../../db/pool');
const { BlobServiceClient, generateBlobSASQueryParameters, BlobSASPermissions, StorageSharedKeyCredential } = require('@azure/storage-blob');

const STORAGE_ACCOUNT_NAME = process.env.AZURE_STORAGE_ACCOUNT_NAME;
const STORAGE_ACCOUNT_KEY = process.env.AZURE_STORAGE_ACCOUNT_KEY;
const CONTAINER_NAME = 'student-documents';
const SESSION_EXPIRY_MINUTES = 25;
const MAX_FILE_SIZE = 5 * 1024 * 1024;

const generateSASUrl = (blobName) => {
  const sharedKeyCredential = new StorageSharedKeyCredential(
    STORAGE_ACCOUNT_NAME,
    STORAGE_ACCOUNT_KEY
  );

  const now = new Date();

  const sasOptions = {
    containerName: CONTAINER_NAME,
    blobName: blobName,
    permissions: BlobSASPermissions.parse('cw'),
    startsOn: new Date(now.getTime() - 5 * 60 * 1000),
    expiresOn: new Date(now.getTime() + SESSION_EXPIRY_MINUTES * 60 * 1000),
    version: '2021-08-06',
  };

  const sasToken = generateBlobSASQueryParameters(
    sasOptions,
    sharedKeyCredential
  ).toString();

  return `https://${STORAGE_ACCOUNT_NAME}.blob.core.windows.net/${CONTAINER_NAME}/${blobName}?${sasToken}`;
};

const blobExists = async (blobName) => {
  const blobServiceClient = BlobServiceClient.fromConnectionString(
    `DefaultEndpointsProtocol=https;AccountName=${STORAGE_ACCOUNT_NAME};AccountKey=${STORAGE_ACCOUNT_KEY};EndpointSuffix=core.windows.net`
  );
  const containerClient = blobServiceClient.getContainerClient(CONTAINER_NAME);
  const blobClient = containerClient.getBlobClient(blobName);
  return await blobClient.exists();
};

const getBlobSize = async (blobName) => {
  const blobServiceClient = BlobServiceClient.fromConnectionString(
    `DefaultEndpointsProtocol=https;AccountName=${STORAGE_ACCOUNT_NAME};AccountKey=${STORAGE_ACCOUNT_KEY};EndpointSuffix=core.windows.net`
  );
  const containerClient = blobServiceClient.getContainerClient(CONTAINER_NAME);
  const blobClient = containerClient.getBlobClient(blobName);
  const properties = await blobClient.getProperties();
  return properties.contentLength;
};

module.exports = async (req, res) => {
  const { action } = req.body;

  const client = await pool.connect();

  try {
    if (action === 'init') {
      const { usn, full_name, email, phone, gender, college_id } = req.body;

      if (!usn || typeof usn !== 'string' || !usn.trim()) {
        return res.status(400).json({ error: 'USN is required' });
      }

      if (!full_name || typeof full_name !== 'string' || !full_name.trim()) {
        return res.status(400).json({ error: 'Full name is required' });
      }

      if (!email || typeof email !== 'string' || !email.trim()) {
        return res.status(400).json({ error: 'Email is required' });
      }

      if (!phone || typeof phone !== 'string' || !phone.trim()) {
        return res.status(400).json({ error: 'Phone is required' });
      }

      if (!gender || !['Male', 'Female', 'Other'].includes(gender)) {
        return res.status(400).json({ error: 'Valid gender is required' });
      }

      if (!college_id || typeof college_id !== 'number') {
        return res.status(400).json({ error: 'College ID is required' });
      }

      const normalizedUSN = usn.trim().toUpperCase();
      const normalizedEmail = email.trim().toLowerCase();
      const normalizedPhone = phone.trim();

      const usnCheck = await client.query(
        'SELECT id FROM students WHERE usn = $1',
        [normalizedUSN]
      );

      if (usnCheck.rows.length > 0) {
        return res.status(400).json({ error: 'USN already registered' });
      }

      const emailCheck = await client.query(
        'SELECT id FROM students WHERE email = $1',
        [normalizedEmail]
      );

      if (emailCheck.rows.length > 0) {
        return res.status(400).json({ error: 'Email already registered' });
      }

      const phoneCheck = await client.query(
        'SELECT id FROM students WHERE phone = $1',
        [normalizedPhone]
      );

      if (phoneCheck.rows.length > 0) {
        return res.status(400).json({ error: 'Phone already registered' });
      }

      const collegeResult = await client.query(
        `SELECT college_code, is_active
         FROM colleges
         WHERE id = $1`,
        [college_id]
      );

      if (collegeResult.rows.length === 0) {
        return res.status(400).json({ error: 'Invalid college' });
      }

      if (!collegeResult.rows[0].is_active) {
        return res.status(400).json({ error: 'College is not active' });
      }

      const college_code = collegeResult.rows[0].college_code;
      const session_id = crypto.randomBytes(32).toString('hex');
      const expires_at = new Date(Date.now() + SESSION_EXPIRY_MINUTES * 60 * 1000);

      await client.query(
        `INSERT INTO registration_sessions 
         (session_id, usn, full_name, email, phone, gender, college_id, expires_at)
         VALUES 
         ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [session_id, normalizedUSN, full_name.trim(), normalizedEmail, normalizedPhone , gender, college_id, expires_at]
      );

      const basePath = `${college_code}/${normalizedUSN}/registration`;
      const upload_urls = {
        passport_photo: generateSASUrl(`${basePath}/passport_photo`),
      };

      return res.status(200).json({
        session_id,
        upload_urls,
        expires_at: expires_at.toISOString(),
      });
    }

    if (action === 'finalize') {
      const { session_id, password } = req.body;

      console.log('[FINALIZE] Starting finalize with session_id:', session_id);

      if (!session_id || typeof session_id !== 'string' || !session_id.trim()) {
        console.log('[FINALIZE] ERROR: Invalid session_id');
        return res.status(400).json({ error: 'Session ID is required' });
      }

      if (!password || typeof password !== 'string' || password.length < 8) {
        console.log('[FINALIZE] ERROR: Invalid password');
        return res.status(400).json({ error: 'Password must be at least 8 characters' });
      }

      console.log('[FINALIZE] Querying registration_sessions...');
      const sessionResult = await client.query(
        `SELECT session_id, usn, full_name, email, phone, gender, college_id, expires_at
         FROM registration_sessions
         WHERE session_id = $1`,
        [session_id.trim()]
      );

      console.log('[FINALIZE] Session query result:', sessionResult.rows);

      if (sessionResult.rows.length === 0) {
        console.log('[FINALIZE] ERROR: No session found');
        return res.status(400).json({ error: 'Invalid or expired session' });
      }

      const session = sessionResult.rows[0];
      console.log('[FINALIZE] Session data:', session);

      const now = new Date();
      const expiryDate = new Date(session.expires_at);

      if (now > expiryDate) {
        console.log('[FINALIZE] ERROR: Session expired');
        await client.query(
          'DELETE FROM registration_sessions WHERE session_id = $1',
          [session_id.trim()]
        );

        return res.status(400).json({ error: 'Session has expired' });
      }

      console.log('[FINALIZE] Querying colleges...');
      const collegeResult = await client.query(
        'SELECT college_code FROM colleges WHERE id = $1',
        [session.college_id]
      );

      console.log('[FINALIZE] College query result:', collegeResult.rows);

      if (collegeResult.rows.length === 0) {
        console.log('[FINALIZE] ERROR: College not found');
        return res.status(400).json({ error: 'College not found' });
      }

      const college_code = collegeResult.rows[0].college_code;
      const passportPhotoBlob = `${college_code}/${session.usn}/registration/passport_photo`;

      console.log('[FINALIZE] Checking blob exists:', passportPhotoBlob);
      const photoExists = await blobExists(passportPhotoBlob);
      console.log('[FINALIZE] Blob exists:', photoExists);

      if (!photoExists) {
        console.log('[FINALIZE] ERROR: Photo not uploaded');
        return res.status(400).json({ error: 'Passport photo not uploaded' });
      }

      console.log('[FINALIZE] Getting blob size...');
      const photoSize = await getBlobSize(passportPhotoBlob);
      console.log('[FINALIZE] Blob size:', photoSize);

      if (photoSize > MAX_FILE_SIZE) {
        console.log('[FINALIZE] ERROR: Photo too large');
        return res.status(400).json({ error: 'Passport photo exceeds 5MB limit' });
      }

      console.log('[FINALIZE] Hashing password...');
      const passwordHash = await bcrypt.hash(password, 10);
      console.log('[FINALIZE] Password hashed successfully');

      const baseUrl = `https://${STORAGE_ACCOUNT_NAME}.blob.core.windows.net/${CONTAINER_NAME}`;
      const passport_photo_url = `${baseUrl}/${college_code}/${session.usn}/registration/passport_photo`;

      console.log('[FINALIZE] Inserting into students table...');
      console.log('[FINALIZE] Insert params:', {
        college_id: session.college_id,
        full_name: session.full_name,
        usn: session.usn,
        email: session.email,
        phone: session.phone,
        gender: session.gender,
        passport_photo_url,
        passwordHash: '***',
        is_active: true
      });

      await client.query(
        `INSERT INTO students 
         (college_id, full_name, usn, email, phone, gender, passport_photo_url, password_hash, is_active)
         VALUES 
         ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [session.college_id, session.full_name, session.usn, session.email, session.phone, session.gender, passport_photo_url, passwordHash, true]
      );

      console.log('[FINALIZE] Student inserted successfully');

      console.log('[FINALIZE] Deleting registration session...');
      await client.query(
        'DELETE FROM registration_sessions WHERE session_id = $1',
        [session_id.trim()]
      );

      console.log('[FINALIZE] Registration complete!');
      return res.status(200).json({
        message: 'Registration successful. You can now login with your credentials.',
      });
    }

    return res.status(400).json({ error: 'Invalid action' });
  } catch (error) {
    console.error('[ERROR] Exception in student-registration:', error);
    console.error('[ERROR] Error message:', error.message);
    console.error('[ERROR] Error stack:', error.stack);
    console.error('[ERROR] Error code:', error.code);
    console.error('[ERROR] Error detail:', error.detail);

    return res.status(500).json({ error: 'An error occurred processing your request' });
  } finally {
    client.release();
  }
};