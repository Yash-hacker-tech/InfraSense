const cloudinary = require("cloudinary").v2;

// Check if Cloudinary credentials are fully configured in environment
function isCloudinaryConfigured() {
  return Boolean(
    process.env.CLOUDINARY_CLOUD_NAME &&
    process.env.CLOUDINARY_API_KEY &&
    process.env.CLOUDINARY_API_SECRET &&
    process.env.CLOUDINARY_CLOUD_NAME.trim() !== "" &&
    process.env.CLOUDINARY_API_KEY.trim() !== "" &&
    process.env.CLOUDINARY_API_SECRET.trim() !== ""
  );
}

// Configure Cloudinary if credentials are present
if (isCloudinaryConfigured()) {
  cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET,
  });
}

/**
 * Helper to upload an image string.
 * If Cloudinary is configured, uploads to Cloudinary and returns secure URL.
 * If Cloudinary is not configured or upload fails, falls back gracefully to storing image data directly.
 * @param {string} base64String - The data URI string or URL.
 * @param {string} folder - The folder to upload into (e.g. "civic/reports").
 * @returns {Promise<string>} The secure_url returned by Cloudinary or original image string.
 */
async function uploadBase64Image(base64String, folder = "civic/reports") {
  if (!base64String) return null;
  // If we already get passed a valid https/http url, just pass it through 
  if (base64String.startsWith("http://") || base64String.startsWith("https://")) {
    return base64String;
  }

  // If Cloudinary is configured, attempt upload
  if (isCloudinaryConfigured()) {
    try {
      const uploadResponse = await cloudinary.uploader.upload(base64String, {
        folder,
        resource_type: "image",
      });
      return uploadResponse.secure_url;
    } catch (error) {
      console.warn("Cloudinary Upload Error (falling back to direct image data):", error.message || error);
      // Fallback gracefully so reporting/resolving issues is never blocked
      return base64String;
    }
  }

  // Cloudinary credentials not provided: store image data directly (supported by schema)
  return base64String;
}

module.exports = {
  uploadBase64Image,
  isCloudinaryConfigured,
};

