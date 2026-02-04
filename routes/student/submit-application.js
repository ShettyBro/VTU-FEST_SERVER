// routes/student/submit-application.js
const express = require('express');
const router = express.Router();
const { authenticate } = require('../../middleware/auth');
const requireRole = require('../../middleware/requireRole');

const nodeCrypto = require('crypto');
// Polyfill for Azure SDK (required in Node runtimes without Web Crypto)
if (!global.crypto) {
  global.crypto = nodeCrypto.webcrypto;
}
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

router.post('/', authenticate, requireRole(['STUDENT']), async (req, res) => {
  if (!req.user) {
    return res.status(401).json({
      success: false,
      message: 'Unauthorized: Missing authentication',
    });
  }

  const student_id = req.user.student_id;
  const college_id = req.user.college_id;

  if (!student_id || !college_id) {
    return res.status(401).json({
      success: false,
      message: 'Invalid token',
    });
  }

  const { action } = req.body;
  const client = await pool.connect();

  try {
    // ✅ FIXED: Changed from 'init' to 'init_application' to match frontend
    if (action === 'init_application') {
      const studentResult = await client.query(
        'SELECT usn, reapply_count FROM students WHERE id = $1',
        [student_id]
      );

      if (studentResult.rows.length === 0) {
        return res.status(404).json({
          success: false,
          error: 'Student not found',
        });
      }

      const student = studentResult.rows[0];
      const reapply_count = student.reapply_count || 0;

      const existingAppResult = await client.query(
        `SELECT id, status
         FROM student_applications
         WHERE student_id = $1
         ORDER BY id DESC
         LIMIT 1`,
        [student_id]
      );

      if (existingAppResult.rows.length > 0) {
        const existingApp = existingAppResult.rows[0];

        if (existingApp.status === 'APPROVED') {
          return res.status(400).json({
            success: false,
            error: 'Application already approved. Cannot resubmit.',
          });
        }

        if (existingApp.status === 'REJECTED' && reapply_count >= 1) {
          return res.status(400).json({
            success: false,
            error: 'Reapplication limit reached. You can only reapply once.',
          });
        }

        if (existingApp.status === 'PENDING') {
          return res.status(400).json({
            success: false,
            error: 'Application already pending. Cannot submit again.',
          });
        }
      }

      const collegeResult = await client.query(
        'SELECT college_code FROM colleges WHERE id = $1',
        [college_id]
      );

      if (collegeResult.rows.length === 0) {
        return res.status(400).json({
          success: false,
          error: 'Invalid college',
        });
      }

      const college_code = collegeResult.rows[0].college_code;
      const session_id = nodeCrypto.randomBytes(32).toString('hex');
      const expires_at = new Date(Date.now() + SESSION_EXPIRY_MINUTES * 60 * 1000);

      await client.query(
        `INSERT INTO application_sessions 
         (session_id, student_id, college_id, expires_at)
         VALUES 
         ($1, $2, $3, $4)`,
        [session_id, student_id, college_id, expires_at]
      );

      // ✅ FIXED: Changed path from 'applications' to 'application' to match Netlify
      const basePath = `${college_code}/${student.usn}/application`;
      const upload_urls = {
        aadhaar: generateSASUrl(`${basePath}/aadhaar`),
        college_id_card: generateSASUrl(`${basePath}/college_id_card`),
        marks_card_10th: generateSASUrl(`${basePath}/marks_card_10th`),
      };

      return res.status(200).json({
        session_id,
        upload_urls,
        expires_at: expires_at.toISOString(),
        message: 'Session created. Please upload documents within 25 minutes.',
      });
    }

    // ✅ FIXED: Changed from 'finalize' to 'finalize_application' to match Netlify
    if (action === 'finalize_application') {
      const { session_id } = req.body;

      if (!session_id || typeof session_id !== 'string' || !session_id.trim()) {
        return res.status(400).json({
          success: false,
          error: 'session_id is required',
        });
      }

      const sessionResult = await client.query(
        `SELECT session_id, student_id, college_id, expires_at
         FROM application_sessions
         WHERE session_id = $1`,
        [session_id.trim()]
      );

      if (sessionResult.rows.length === 0) {
        return res.status(400).json({
          success: false,
          error: 'Invalid or expired session',
        });
      }

      const session = sessionResult.rows[0];

      if (session.student_id !== student_id) {
        return res.status(403).json({
          success: false,
          error: 'Unauthorized',
        });
      }

      const now = new Date();
      const expiryDate = new Date(session.expires_at);
      if (now > expiryDate) {
        await client.query(
          'DELETE FROM application_sessions WHERE session_id = $1',
          [session_id.trim()]
        );
        return res.status(400).json({
          success: false,
          error: 'Session has expired',
        });
      }

      const studentResult = await client.query(
        'SELECT usn, reapply_count FROM students WHERE id = $1',
        [student_id]
      );
      const student = studentResult.rows[0];

      const collegeResult = await client.query(
        'SELECT college_code FROM colleges WHERE id = $1',
        [college_id]
      );
      const college_code = collegeResult.rows[0].college_code;

      // ✅ FIXED: Changed path from 'applications' to 'application'
      const basePath = `${college_code}/${student.usn}/application`;
      const collegeIdCardBlob = `${basePath}/college_id_card`;
      const aadhaarBlob = `${basePath}/aadhaar`;
      const marksCardBlob = `${basePath}/marks_card_10th`;

      const collegeIdCardExists = await blobExists(collegeIdCardBlob);
      if (!collegeIdCardExists) {
        return res.status(400).json({
          success: false,
          error: 'College ID card not uploaded',
        });
      }

      const aadhaarExists = await blobExists(aadhaarBlob);
      if (!aadhaarExists) {
        return res.status(400).json({
          success: false,
          error: 'Aadhaar not uploaded',
        });
      }

      const marksCardExists = await blobExists(marksCardBlob);
      if (!marksCardExists) {
        return res.status(400).json({
          success: false,
          error: '10th marks card not uploaded',
        });
      }

      const collegeIdCardSize = await getBlobSize(collegeIdCardBlob);
      if (collegeIdCardSize > MAX_FILE_SIZE) {
        return res.status(400).json({
          success: false,
          error: 'College ID card exceeds 5MB limit',
        });
      }

      const aadhaarSize = await getBlobSize(aadhaarBlob);
      if (aadhaarSize > MAX_FILE_SIZE) {
        return res.status(400).json({
          success: false,
          error: 'Aadhaar exceeds 5MB limit',
        });
      }

      const marksCardSize = await getBlobSize(marksCardBlob);
      if (marksCardSize > MAX_FILE_SIZE) {
        return res.status(400).json({
          success: false,
          error: '10th marks card exceeds 5MB limit',
        });
      }

      const baseUrl = `https://${STORAGE_ACCOUNT_NAME}.blob.core.windows.net/${CONTAINER_NAME}`;
      const collegeIdCardUrl = `${baseUrl}/${basePath}/college_id_card`;
      const aadhaarUrl = `${baseUrl}/${basePath}/aadhaar`;
      const marksCardUrl = `${baseUrl}/${basePath}/marks_card_10th`;

      const existingAppResult = await client.query(
        `SELECT id, status
         FROM student_applications
         WHERE student_id = $1
         ORDER BY id DESC
         LIMIT 1`,
        [student_id]
      );

      let application_id;
      let is_reapply = false;

      await client.query('BEGIN');

      try {
        if (existingAppResult.rows.length > 0) {
          const existingApp = existingAppResult.rows[0];

          if (existingApp.status === 'APPROVED') {
            await client.query('ROLLBACK');
            return res.status(400).json({
              success: false,
              error: 'Application already approved. Cannot resubmit.',
            });
          }

          if (existingApp.status === 'PENDING') {
            await client.query('ROLLBACK');
            return res.status(400).json({
              success: false,
              error: 'Application already pending. Cannot submit again.',
            });
          }

          if (existingApp.status === 'REJECTED') {
            const reapply_count = student.reapply_count || 0;
            if (reapply_count >= 1) {
              await client.query('ROLLBACK');
              return res.status(400).json({
                success: false,
                error: 'Reapplication limit reached. You can only reapply once.',
              });
            }

            const insertResult = await client.query(
              `INSERT INTO student_applications
               (student_id, status, submitted_at)
               VALUES
               ($1, 'PENDING', NOW())
               RETURNING id`,
              [student_id]
            );
            application_id = insertResult.rows[0].id;
            is_reapply = true;

            await client.query(
              'UPDATE students SET reapply_count = $1 WHERE id = $2',
              [reapply_count + 1, student_id]
            );
          }
        } else {
          const insertResult = await client.query(
            `INSERT INTO student_applications
             (student_id, status, submitted_at)
             VALUES
             ($1, 'PENDING', NOW())
             RETURNING id`,
            [student_id]
          );
          application_id = insertResult.rows[0].id;
        }

        await client.query(
          `INSERT INTO application_documents
           (application_id, document_type, document_url)
           VALUES
           ($1, 'college_id_card', $2)`,
          [application_id, collegeIdCardUrl]
        );

        await client.query(
          `INSERT INTO application_documents
           (application_id, document_type, document_url)
           VALUES
           ($1, 'aadhaar', $2)`,
          [application_id, aadhaarUrl]
        );

        await client.query(
          `INSERT INTO application_documents
           (application_id, document_type, document_url)
           VALUES
           ($1, 'sslc', $2)`,
          [application_id, marksCardUrl]
        );

        await client.query('COMMIT');

        await client.query(
          'DELETE FROM application_sessions WHERE session_id = $1',
          [session_id.trim()]
        );

        return res.status(200).json({
          message: is_reapply 
            ? 'Application resubmitted successfully' 
            : 'Application submitted successfully',
          application_id,
        });
      } catch (txError) {
        await client.query('ROLLBACK');
        throw txError;
      }
    }

    return res.status(400).json({
      success: false,
      error: 'Invalid action',
    });
  } catch (error) {
    console.error('Error in submit-application:', error);
    return res.status(500).json({
      success: false,
      error: 'Internal server error',
      details: error.message,
    });
  } finally {
    client.release();
  }
});

module.exports = router;