// routes/student/submit-application.js
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

module.exports = async (req, res) => {
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
    if (action === 'init') {
      const studentResult = await client.query(
        'SELECT usn, reapply_count FROM students WHERE id = $1',
        [student_id]
      );

      if (studentResult.rows.length === 0) {
        return res.status(404).json({
          success: false,
          message: 'Student not found',
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
            message: 'Application already approved. Cannot resubmit.',
          });
        }

        if (existingApp.status === 'REJECTED' && reapply_count >= 1) {
          return res.status(400).json({
            success: false,
            message: 'Reapplication limit reached. You can only reapply once.',
          });
        }

        if (existingApp.status === 'PENDING') {
          return res.status(400).json({
            success: false,
            message: 'Application already pending. Cannot submit again.',
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
          message: 'Invalid college',
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

      const basePath = `${college_code}/${student.usn}/applications`;
      const upload_urls = {
        college_id_card: generateSASUrl(`${basePath}/college_id_card`),
        aadhaar: generateSASUrl(`${basePath}/aadhaar`),
        sslc: generateSASUrl(`${basePath}/sslc`),
      };

      return res.status(200).json({
        success: true,
        session_id,
        upload_urls,
        expires_at: expires_at.toISOString(),
      });
    }

    if (action === 'finalize') {
      const { session_id } = req.body;

      if (!session_id || typeof session_id !== 'string' || !session_id.trim()) {
        return res.status(400).json({
          success: false,
          message: 'Session ID is required',
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
          message: 'Invalid or expired session',
        });
      }

      const session = sessionResult.rows[0];

      if (session.student_id !== student_id) {
        return res.status(403).json({
          success: false,
          message: 'Unauthorized',
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
          message: 'Session has expired',
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

      const basePath = `${college_code}/${student.usn}/applications`;
      const collegeIdCardBlob = `${basePath}/college_id_card`;
      const aadhaarBlob = `${basePath}/aadhaar`;
      const sslcBlob = `${basePath}/sslc`;

      const collegeIdCardExists = await blobExists(collegeIdCardBlob);
      if (!collegeIdCardExists) {
        return res.status(400).json({
          success: false,
          message: 'College ID card not uploaded',
        });
      }

      const aadhaarExists = await blobExists(aadhaarBlob);
      if (!aadhaarExists) {
        return res.status(400).json({
          success: false,
          message: 'Aadhaar not uploaded',
        });
      }

      const sslcExists = await blobExists(sslcBlob);
      if (!sslcExists) {
        return res.status(400).json({
          success: false,
          message: 'SSLC not uploaded',
        });
      }

      const collegeIdCardSize = await getBlobSize(collegeIdCardBlob);
      if (collegeIdCardSize > MAX_FILE_SIZE) {
        return res.status(400).json({
          success: false,
          message: 'College ID card exceeds 5MB limit',
        });
      }

      const aadhaarSize = await getBlobSize(aadhaarBlob);
      if (aadhaarSize > MAX_FILE_SIZE) {
        return res.status(400).json({
          success: false,
          message: 'Aadhaar exceeds 5MB limit',
        });
      }

      const sslcSize = await getBlobSize(sslcBlob);
      if (sslcSize > MAX_FILE_SIZE) {
        return res.status(400).json({
          success: false,
          message: 'SSLC exceeds 5MB limit',
        });
      }

      const baseUrl = `https://${STORAGE_ACCOUNT_NAME}.blob.core.windows.net/${CONTAINER_NAME}`;
      const collegeIdCardUrl = `${baseUrl}/${basePath}/college_id_card`;
      const aadhaarUrl = `${baseUrl}/${basePath}/aadhaar`;
      const sslcUrl = `${baseUrl}/${basePath}/sslc`;

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
              message: 'Application already approved. Cannot resubmit.',
            });
          }

          if (existingApp.status === 'PENDING') {
            await client.query('ROLLBACK');
            return res.status(400).json({
              success: false,
              message: 'Application already pending. Cannot submit again.',
            });
          }

          if (existingApp.status === 'REJECTED') {
            const reapply_count = student.reapply_count || 0;
            if (reapply_count >= 1) {
              await client.query('ROLLBACK');
              return res.status(400).json({
                success: false,
                message: 'Reapplication limit reached. You can only reapply once.',
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
          [application_id, sslcUrl]
        );

        await client.query('COMMIT');

        await client.query(
          'DELETE FROM application_sessions WHERE session_id = $1',
          [session_id.trim()]
        );

        return res.status(200).json({
          success: true,
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
      message: 'Invalid action',
    });
  } catch (error) {
    console.error('Error in submit-application:', error);
    return res.status(500).json({
      success: false,
      message: 'An error occurred processing your request',
    });
  } finally {
    client.release();
  }
};