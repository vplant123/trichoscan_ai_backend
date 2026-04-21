const { S3Client, GetObjectCommand } = require("@aws-sdk/client-s3");
const { getSignedUrl } = require("@aws-sdk/s3-request-presigner");
const { Upload } = require("@aws-sdk/lib-storage");
const sharp = require("sharp");

/**
 * TrichoScan AI — Storage Service (S3 Cloud Migration v12.0)
 * 
 * Implements §6.2 (Image Processing) and §9 (Image Validation) of prd.md.
 * MOVED: Local FS Decommissioned → S3 Bucket 
 * 
 * FOLDERS:
 *   - images/ : scalp photos
 *   - reports/ : clinical reports
 */

const s3Client = new S3Client({
  region: process.env.AWS_REGION,
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  },
});

const BUCKET = process.env.AWS_S3_BUCKET;

async function saveImage(buffer, sessionId, originalName) {
  try {
    const filename = `scalp_${sessionId}_${Date.now()}.jpg`;
    const key = `images/${filename}`;

    // ── IMAGE PREPROCESSING PIPELINE ──────────────
    const processedBuffer = await sharp(buffer)
      .rotate()
      .resize({ width: 1240, withoutEnlargement: true })
      .jpeg({ quality: 85, chromaSubsampling: "4:4:4" })
      .toBuffer();

    const upload = new Upload({
      client: s3Client,
      params: {
        Bucket: BUCKET,
        Key: key,
        Body: processedBuffer,
        ContentType: "image/jpeg",
        // ACL: "public-read", // Re-enable if public access is desired/configured on bucket
      },
    });

    await upload.done();

    const url = `https://${BUCKET}.s3.${process.env.AWS_REGION}.amazonaws.com/${key}`;
    console.log(`[StorageService] Image Processed & Uploaded to S3: ${key}`);

    return {
      url: url,
      fileKey: key,
      size: processedBuffer.length,
      mimeType: "image/jpeg"
    };
  } catch (error) {
    console.error("[StorageService] S3 image upload failure:", error.message);
    throw new Error(`S3 Storage Error: ${error.message}`);
  }
}

async function saveReport(buffer, sessionId) {
  try {
    const filename = `report_${sessionId}_${Date.now()}.pdf`;
    const key = `reports/${filename}`;

    const upload = new Upload({
      client: s3Client,
      params: {
        Bucket: BUCKET,
        Key: key,
        Body: buffer,
        ContentType: "application/pdf",
        // ACL: "public-read",
      },
    });

    await upload.done();

    const url = `https://${BUCKET}.s3.${process.env.AWS_REGION}.amazonaws.com/${key}`;
    console.log(`[StorageService] PDF Processed & Uploaded to S3: ${key}`);

    return {
      url: url,
      fileKey: key
    };
  } catch (error) {
    console.error("[StorageService] S3 PDF upload failure:", error.message);
    throw new Error(`S3 PDF Storage Error: ${error.message}`);
  }
}

async function getFileBuffer(keyOrUrl) {
  try {
    let key = keyOrUrl;
    if (keyOrUrl.startsWith("http")) {
      // Extract key from URL: https://bucket.s3.region.amazonaws.com/images/file.jpg -> images/file.jpg
      const url = new URL(keyOrUrl);
      // If URL has path like /images/foo.jpg, slice(1) to get images/foo.jpg
      key = url.pathname.startsWith("/") ? url.pathname.slice(1) : url.pathname;
    }

    const command = new GetObjectCommand({
      Bucket: BUCKET,
      Key: key
    });

    const response = await s3Client.send(command);
    const arrayBuffer = await response.Body.transformToByteArray();
    return Buffer.from(arrayBuffer);
  } catch (error) {
    console.error(`[StorageService] S3 read failure for ${keyOrUrl}:`, error.message);
    throw new Error(`S3_READ_FAILURE: ${error.message}`);
  }
}

/**
 * Generates a temporary access URL for a private S3 object.
 * (PRD §8.3: Secure Data Access)
 */
async function generatePresignedUrl(keyOrUrl, expiresInSeconds = 604800) {
  try {
    if (!keyOrUrl) return null;
    
    let key = keyOrUrl;
    if (keyOrUrl.startsWith("http")) {
      const url = new URL(keyOrUrl);
      key = url.pathname.startsWith("/") ? url.pathname.slice(1) : url.pathname;
    }

    const command = new GetObjectCommand({
      Bucket: BUCKET,
      Key: key
    });

    return await getSignedUrl(s3Client, command, { expiresIn: expiresInSeconds });
  } catch (error) {
    console.error(`[StorageService] Presigning failure for ${keyOrUrl}:`, error.message);
    return keyOrUrl; // Fallback to original URL
  }
}

module.exports = { saveImage, saveReport, getFileBuffer, generatePresignedUrl };
