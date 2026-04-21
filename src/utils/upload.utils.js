const cloudinary = require("cloudinary").v2;
const multer = require("multer");
const fs = require("fs");
const sharp = require("sharp");

cloudinary.config({
  cloud_name: "drkpwvnun",
  api_key: "692814272862656",
  api_secret: "qrGHTQqUICbzjuf00fTH33TRODU",
});
console.log("key", process.env.CLOUDINARY_API_KEY);

const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, __dirname + "/public/temp");
  },
  filename: function (req, file, cb) {
    cb(null, file.originalname);
  },
});

const upload = multer({
  storage: storage,
  limits: {
    fileSize: 1024 * 1024 * 5, // 5MB limit
  },
  fileFilter: function (req, file, cb) {
    // Accept only image files
    if (!file.mimetype.startsWith("image/")) {
      return cb(new Error("Only image files are allowed!"), false);
    }
    cb(null, true);
  },
});

const compressImage = async (inputPath, outputPath) => {
  try {
    await sharp(inputPath)
      .resize({
        width: 1920, // Max width while maintaining aspect ratio
        height: 1080, // Max height while maintaining aspect ratio
        fit: "inside", // Ensure image fits within these dimensions
        withoutEnlargement: true, // Prevent upscaling
      })
      .jpeg({ quality: 80, progressive: true }) // Compress JPEG with good quality
      .webp({ quality: 80 }) // Convert to WebP for better compression
      .toFile(outputPath);
    return true;
  } catch (error) {
    console.error("Error compressing image:", error);
    return false;
  }
};

const uploadImageToCloudinary = (file) => {
  return new Promise(async (resolve, reject) => {
    const compressedPath = file.path.replace(/(\.\w+)$/, "-compressed.webp");

    // Compress the image first
    const compressionSuccess = await compressImage(file.path, compressedPath);

    if (!compressionSuccess) {
      // Delete original file if compression fails
      fs.unlink(file.path, (err) => {
        if (err) console.error("Error deleting original file:", err);
      });
      return reject(new Error("Image compression failed"));
    }

    // Upload compressed image to Cloudinary
    cloudinary.uploader.upload(
      compressedPath,
      {
        folder: "hair-assessment",
        use_filename: true,
        unique_filename: false,
        public_id: file?.filename?.replace(/(\.\w+)$/, "") || Date.now(),
        format: "webp", // Ensure Cloudinary uses WebP format
      },
      (error, result) => {
        // Clean up both original and compressed files
        [file.path, compressedPath].forEach((path) => {
          fs.unlink(path, (err) => {
            if (err) console.error("Error deleting file:", err);
          });
        });

        if (error) {
          reject(error);
        } else {
          resolve(result.secure_url);
        }
      }
    );
  });
};

module.exports = { upload, uploadImageToCloudinary };
