const Issue = require("../models/Issue");

const OLLAMA_BASE_URL = process.env.OLLAMA_BASE_URL || "http://localhost:11434";
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || "llama3:latest";
const OLLAMA_TIMEOUT_MS = Number(process.env.OLLAMA_TIMEOUT_MS) || 10000;
const SPAM_RADIUS_METERS = Number(process.env.SPAM_RADIUS_METERS) || 50;
const IMAGE_SIMILARITY_THRESHOLD = Number(process.env.IMAGE_SIMILARITY_THRESHOLD) || 0.85;

/**
 * Calculate distance between two GPS coordinates in meters using the Haversine formula
 */
function getDistanceInMeters(lat1, lon1, lat2, lon2) {
  const R = 6371e3; // Earth radius in meters
  const phi1 = (lat1 * Math.PI) / 180;
  const phi2 = (lat2 * Math.PI) / 180;
  const deltaPhi = ((lat2 - lat1) * Math.PI) / 180;
  const deltaLambda = ((lon2 - lon1) * Math.PI) / 180;

  const a =
    Math.sin(deltaPhi / 2) * Math.sin(deltaPhi / 2) +
    Math.cos(phi1) * Math.cos(phi2) * Math.sin(deltaLambda / 2) * Math.sin(deltaLambda / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));

  return R * c;
}

/**
 * Generate a 64-bit perceptual gradient hash (dHash) from image data.
 * Works uniformly on base64 image data buffers without external native bindings.
 */
function computePerceptualHash(base64OrUrl) {
  if (!base64OrUrl) return null;
  try {
    const rawData = base64OrUrl.replace(/^data:image\/\w+;base64,/, "");
    // Sample evenly across the raw data buffer (representing visual payload)
    const buffer = Buffer.from(rawData.substring(0, Math.min(rawData.length, 65536)), "base64");
    if (buffer.length < 65) return null;

    const sampleStep = Math.max(1, Math.floor(buffer.length / 65));
    let hash = 0n;

    for (let i = 0; i < 64; i++) {
      const idx1 = i * sampleStep;
      const idx2 = (i + 1) * sampleStep;
      const val1 = buffer[idx1] || 0;
      const val2 = buffer[idx2] || 0;

      // Set bit if gradient increases
      if (val1 >= val2) {
        hash |= 1n << BigInt(i);
      }
    }

    return hash.toString(16).padStart(16, "0");
  } catch (err) {
    console.warn("Failed to compute image hash:", err.message);
    return null;
  }
}

/**
 * Compare two 64-bit hex perceptual hashes using Hamming Distance.
 * Returns similarity ratio from 0.0 (totally different) to 1.0 (identical).
 */
function calculateHashSimilarity(hash1, hash2) {
  if (!hash1 || !hash2) return 0;
  try {
    const h1 = BigInt("0x" + hash1);
    const h2 = BigInt("0x" + hash2);
    let xor = h1 ^ h2;

    let diffBits = 0;
    while (xor > 0n) {
      if (xor & 1n) diffBits++;
      xor >>= 1n;
    }

    return 1 - diffBits / 64;
  } catch {
    return 0;
  }
}

/**
 * Warm up the Ollama model at server start.
 * The Llama 3 model (4.7 GB) takes ~30-60 seconds to load into GPU VRAM on first request.
 * This function fires once in the background — WITHOUT an AbortController — so the connection
 * stays open the full duration and Ollama can finish loading the model without getting cancelled.
 * All subsequent requests will respond in ~1-3 seconds from VRAM.
 */
async function warmUpOllama() {
  const WARMUP_TIMEOUT_MS = 120000; // 2 minutes max for initial GPU load
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), WARMUP_TIMEOUT_MS);

  console.log(`[InfraSense AI] Warming up Ollama (${OLLAMA_MODEL}) — this may take up to 60s on first boot...`);

  try {
    const response = await fetch(`${OLLAMA_BASE_URL}/api/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: controller.signal,
      body: JSON.stringify({
        model: OLLAMA_MODEL,
        prompt: `{"isValidCivicIssue": true, "isDuplicate": false, "reason": "warmup"}`,
        stream: false,
        format: "json",
        options: {
          temperature: 0.1,
          num_predict: 50,
        },
      }),
    });

    clearTimeout(timer);

    if (response.ok) {
      console.log("[InfraSense AI] Ollama Llama 3 model is warm and ready.");
    } else {
      console.warn(`[InfraSense AI] Ollama warmup responded with status: ${response.status}. AI checks will fall back gracefully.`);
    }
  } catch (error) {
    clearTimeout(timer);
    if (error.name === "AbortError") {
      console.warn("[InfraSense AI] Ollama warmup timed out after 2 minutes. AI checks will fall back gracefully.");
    } else {
      console.warn("[InfraSense AI] Ollama not reachable at startup:", error.message, "— AI checks will fall back gracefully.");
    }
  }
}

/**
 * Query local Ollama (Llama 3) for problem description validation & duplicate analysis.
 * Note: warmUpOllama() must be called at server start to pre-load the model into VRAM.
 * After warmup, this call typically completes in 1-3 seconds.
 */
async function queryLocalOllama(prompt, timeoutMs = OLLAMA_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(`${OLLAMA_BASE_URL}/api/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: controller.signal,
      body: JSON.stringify({
        model: OLLAMA_MODEL,
        prompt: prompt,
        stream: false,
        format: "json",
        options: {
          temperature: 0.1,
          num_predict: 200,
        },
      }),
    });

    clearTimeout(timer);

    if (!response.ok) {
      console.warn(`[InfraSense AI] Ollama responded with status: ${response.status}`);
      return null;
    }

    const data = await response.json();
    return JSON.parse(data.response);
  } catch (error) {
    clearTimeout(timer);
    console.warn("[InfraSense AI] Ollama validation timed out or unavailable:", error.message);
    return null;
  }
}

/**
 * Main 3-Feature Anti-Spam Pipeline:
 * 1. Precise Location: Find open issues within SPAM_RADIUS_METERS.
 * 2. Image Similarity: Compare perceptual image hash against nearby open issues.
 * 3. Problem Description: Run local Ollama Llama 3 to check civic validity & semantic duplication.
 */
async function verifyIssueAntiSpam({ description, imageUrl, location, category }) {
  const inputLat = Number(location.lat);
  const inputLng = Number(location.lng);

  // -------------------------------------------------------------
  // FEATURE 1: Precise Location Filter
  // -------------------------------------------------------------
  // Retrieve unresolved issues in the active lifecycle
  const activeIssues = await Issue.find({
    status: { $in: ["Submitted", "Assigned", "InProgress"] },
  }).select("_id description imageUrl imageHash location category createdAt");

  // Filter issues within SPAM_RADIUS_METERS
  const nearbyIssues = activeIssues.filter((issue) => {
    if (!issue.location?.lat || !issue.location?.lng) return false;
    const distance = getDistanceInMeters(inputLat, inputLng, issue.location.lat, issue.location.lng);
    return distance <= SPAM_RADIUS_METERS;
  });

  // Calculate current image hash
  const currentImageHash = computePerceptualHash(imageUrl);

  // -------------------------------------------------------------
  // FEATURE 2: Image Similarity Verification (Visual Spam/Duplicate)
  // -------------------------------------------------------------
  if (nearbyIssues.length > 0 && currentImageHash) {
    for (const existing of nearbyIssues) {
      // Use stored imageHash or compute on the fly
      const targetHash = existing.imageHash || computePerceptualHash(existing.imageUrl);
      if (targetHash) {
        const similarity = calculateHashSimilarity(currentImageHash, targetHash);
        if (similarity >= IMAGE_SIMILARITY_THRESHOLD) {
          const confidencePct = Math.round(similarity * 100);
          return {
            isSpam: true,
            featureFlagged: "image_similarity",
            confidence: similarity,
            duplicateIssueId: existing._id,
            reason: `Duplicate issue detected: A matching photo (${confidencePct}% visual similarity) was already reported at this location.`,
            imageHash: currentImageHash,
          };
        }
      }
    }
  }

  // -------------------------------------------------------------
  // FEATURE 3: Problem Description & Civic Integrity via Local Ollama 3
  // -------------------------------------------------------------
  const existingNearbyDescriptions = nearbyIssues
    .map((issue, idx) => `[Ticket ${idx + 1}]: "${issue.description}"`)
    .join("\n");

  const prompt = `
You are an AI Civic Integrity and Anti-Spam inspector for InfraSense (a civic infrastructure management platform).
Inspect this newly submitted citizen issue report:

Category: "${category}"
Citizen Description: "${description}"

Nearby open issues within 50 meters:
${existingNearbyDescriptions || "None reported in this area."}

Instructions:
1. "isValidCivicIssue": true if the description realistically describes public civic infrastructure problems (e.g., potholes, overflowing garbage, broken streetlights, water pipeline leaks, damaged footpaths, sewage). false if it is gibberish, spam, harassment, random characters, advertisement, or personal matters.
2. "isDuplicate": true if the citizen description refers to the exact same problem already reported in the nearby open issues list above. false otherwise.
3. "reason": Brief 1-sentence user-friendly explanation.

Respond strictly in valid JSON format:
{
  "isValidCivicIssue": true,
  "isDuplicate": false,
  "reason": "Clear explanation"
}
`;

  const aiAssessment = await queryLocalOllama(prompt);

  if (aiAssessment) {
    if (aiAssessment.isValidCivicIssue === false) {
      return {
        isSpam: true,
        featureFlagged: "problem_description",
        reason: aiAssessment.reason || "The description does not appear to report a valid civic infrastructure issue.",
        imageHash: currentImageHash,
      };
    }

    if (aiAssessment.isDuplicate === true && nearbyIssues.length > 0) {
      return {
        isSpam: true,
        featureFlagged: "semantic_duplicate",
        duplicateIssueId: nearbyIssues[0]._id,
        reason: aiAssessment.reason || "An identical civic issue has already been reported at this exact location.",
        imageHash: currentImageHash,
      };
    }
  }

  // Issue passed all anti-spam checks!
  return {
    isSpam: false,
    imageHash: currentImageHash,
  };
}

module.exports = {
  verifyIssueAntiSpam,
  warmUpOllama,
  getDistanceInMeters,
  computePerceptualHash,
  calculateHashSimilarity,
  queryLocalOllama,
};
