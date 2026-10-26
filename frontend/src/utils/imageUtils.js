/**
 * Image processing and compression utilities for InfraSense
 */

export function validateImageFile(file) {
  if (!file) {
    return { valid: false, error: "No file selected." };
  }

  // Check MIME type
  const isImageMime = file.type && file.type.startsWith("image/");
  // Fallback extension check for camera files that might lack proper mime on some systems
  const hasImageExtension = /\.(jpe?g|png|webp|gif|bmp|heic|heif|svg)$/i.test(file.name || "");

  if (!isImageMime && !hasImageExtension) {
    return {
      valid: false,
      error: "Please select a valid image file (JPEG, PNG, WebP, GIF).",
    };
  }

  return { valid: true };
}

/**
 * Reads a File and optimizes/compresses it to a Base64 JPEG data URL.
 * Scales down large camera photos (e.g., 4000x3000 down to max 1600x1600)
 * keeping file sizes lightweight (150-350KB) and instant to upload.
 *
 * @param {File} file
 * @param {object} options
 * @returns {Promise<string>} Base64 Data URL
 */
export function compressAndReadImage(file, options = {}) {
  const { maxWidth = 1600, maxHeight = 1600, quality = 0.85 } = options;

  return new Promise((resolve, reject) => {
    const validation = validateImageFile(file);
    if (!validation.valid) {
      return reject(new Error(validation.error));
    }

    const reader = new FileReader();

    reader.onerror = () => {
      reject(new Error("Unable to read image file. Please try another image."));
    };

    reader.onload = () => {
      const originalDataUrl = reader.result;

      // For SVGs or GIFs where we want to preserve animation/vector, return original
      if (file.type === "image/svg+xml" || file.type === "image/gif") {
        return resolve(originalDataUrl);
      }

      const img = new Image();
      img.onerror = () => {
        // Fallback to original data URL if image decoding fails in canvas
        resolve(originalDataUrl);
      };

      img.onload = () => {
        try {
          let { width, height } = img;

          // Check if resizing is necessary
          if (width > maxWidth || height > maxHeight) {
            const ratio = Math.min(maxWidth / width, maxHeight / height);
            width = Math.round(width * ratio);
            height = Math.round(height * ratio);
          }

          const canvas = document.createElement("canvas");
          canvas.width = width;
          canvas.height = height;

          const ctx = canvas.getContext("2d");
          if (!ctx) {
            return resolve(originalDataUrl);
          }

          // Fill white background in case of transparent PNG converted to JPEG
          ctx.fillStyle = "#ffffff";
          ctx.fillRect(0, 0, width, height);

          ctx.drawImage(img, 0, 0, width, height);

          const compressedDataUrl = canvas.toDataURL("image/jpeg", quality);
          resolve(compressedDataUrl);
        } catch (err) {
          console.warn("Canvas compression failed, falling back to original:", err);
          resolve(originalDataUrl);
        }
      };

      img.src = originalDataUrl;
    };

    reader.readAsDataURL(file);
  });
}
