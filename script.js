/**
 * script.js — SpeechLess main application
 *
 * Changes from original:
 *  - Imports LocalCameraSource and ESP32CameraSource from camera-source.js
 *  - initWebcam() replaced by camera-source abstraction (connect/disconnect)
 *  - detectFrame() now reads from activeSource.getVideoElement() instead of
 *    directly from the hardcoded #webcam element
 *  - Camera-selector UI (Local Webcam / ESP32-CAM) wired in setupEventListeners
 *  - All original gesture-recognition, TTS, finger-state and display logic is
 *    UNCHANGED.
 */

import {
    LocalCameraSource,
    ESP32CameraSource,
    SOURCE_STATUS,
} from "./camera-source.js";

// ─── Constants (UNCHANGED) ────────────────────────────────────────────────────

const TTS_COOLDOWN_MS = 2500;

const GESTURE_COOLDOWN_MS = 600;

const GESTURE_CONFIRM_FRAMES = 7;

const MIN_HAND_PRESENCE_CONFIDENCE = 0.65;


const TRANSLATIONS = {
    en: {
        Hello: "Hello", Good: "Good", Stop: "Stop",
        Sorry: "Sorry", "Thank You": "Thank You", Bye: "Bye",
        Yes: "Yes", No: "No", Help: "Help",
    },
    hi: {
        Hello: "नमस्ते", Good: "अच्छा", Stop: "रुको",
        Sorry: "माफ़ कीजिए", "Thank You": "धन्यवाद", Bye: "अलविदा",
        Yes: "हाँ", No: "नहीं", Help: "मदद",
    },
};


const GESTURE_MAP = {
    "01000": "Hello",
    "10000": "Good",
    "11111": "Stop",
    "00000": "Sorry",
    "01100": "Thank You",
    "00001": "Bye",
    "11000": "Yes",
    "10001": "No",
    "01110": "Help",
};


const HAND_CONNECTIONS = [
    [0,1],[1,2],[2,3],[3,4],
    [0,5],[5,6],[6,7],[7,8],
    [0,9],[9,10],[10,11],[11,12],
    [0,13],[13,14],[14,15],[15,16],
    [0,17],[17,18],[18,19],[19,20],
    [5,9],[9,13],[13,17],
];

// ─── DOM references (UNCHANGED) ───────────────────────────────────────────────

const webcamEl         = document.getElementById("webcam");
const canvasEl         = document.getElementById("outputCanvas");
const canvasCtx        = canvasEl.getContext("2d");

const cameraOverlay    = document.getElementById("cameraOverlay");
const errorOverlay     = document.getElementById("errorOverlay");
const startBtn         = document.getElementById("startBtn");
const stopBtn          = document.getElementById("stopBtn");

const gestureTextEl    = document.getElementById("gestureText");
const translatedTextEl = document.getElementById("translatedText");
const fpsBadgeEl       = document.getElementById("fpsBadge");
const subtitleTextEl   = document.getElementById("subtitleText");
const gestureCardEl    = document.getElementById("gestureCard");

const voiceToggleEl    = document.getElementById("voiceToggle");
const voiceStatusText  = document.getElementById("voiceStatusText");
const statusDotEl      = document.getElementById("statusDot");
const voiceInfoEl      = document.getElementById("voiceInfo");

const languageSelectEl = document.getElementById("languageSelect");
const guideToggleEl    = document.getElementById("guideToggle");
const guidePanelEl     = document.getElementById("guidePanel");

const fingerEls = {
    thumb:  document.getElementById("finger-thumb"),
    index:  document.getElementById("finger-index"),
    middle: document.getElementById("finger-middle"),
    ring:   document.getElementById("finger-ring"),
    pinky:  document.getElementById("finger-pinky"),
};

// ─── Camera-source selector + debug panel DOM references ─────────────────────

const cameraSourceSelect  = document.getElementById("cameraSourceSelect");
const esp32Panel          = document.getElementById("esp32Panel");
const esp32UrlInput       = document.getElementById("esp32UrlInput");
const esp32ConnectBtn     = document.getElementById("esp32ConnectBtn");
const esp32StatusDot      = document.getElementById("esp32StatusDot");
const esp32StatusText     = document.getElementById("esp32StatusText");

// Mode selector buttons (Requirement 15: Stream-Only vs AI Tracking)
const modeAiBtn           = document.getElementById("modeAiBtn");
const modeStreamOnlyBtn   = document.getElementById("modeStreamOnlyBtn");

// Diagnostics & Benchmark elements (Requirement 14 & 16)
const debugToggleBtn      = document.getElementById("debugToggleBtn");
const debugPanel          = document.getElementById("debugPanel");
const dbgConn             = document.getElementById("dbgConn");
const dbgFps              = document.getElementById("dbgFps");
const dbgLatency          = document.getElementById("dbgLatency");
const dbgJpegKb           = document.getElementById("dbgJpegKb");
const dbgReceived         = document.getElementById("dbgReceived");
const dbgProcessed        = document.getElementById("dbgProcessed");
const dbgDropped          = document.getElementById("dbgDropped");
const dbgSource           = document.getElementById("dbgSource");
const dbgRssi             = document.getElementById("dbgRssi");
const dbgMpFps            = document.getElementById("dbgMpFps");
const dbgMpTime           = document.getElementById("dbgMpTime");
const runBenchmarkBtn     = document.getElementById("runBenchmarkBtn");
const benchmarkResult     = document.getElementById("benchmarkResult");

// MediaPipe FPS & Diagnostic counters
let _mpFrameCount          = 0;
let _mpFps                 = 0;
let mpFramesProcessedCount = 0;
let mediaPipeDurationMs    = 0;
setInterval(() => { _mpFps = _mpFrameCount; _mpFrameCount = 0; }, 1000);

// Latest-Frame MediaPipe Scheduler State (Requirements 2, 3, 6, 7)
let isStreamOnlyMode          = false;
let isMediaPipeBusy           = false;
let lastProcessedFrameId      = -1;
let lastMediaPipeRunTime      = 0;
let targetMediaPipeIntervalMs = 66; // Initial target ~15 FPS (adaptive between 66ms–120ms)
let lastMpTimestamp           = 0;
let lastTrackedLandmarks      = null;

// ─── Application state (UNCHANGED) ───────────────────────────────────────────

let handLandmarker = null;
let isDetecting = false;
let animationFrameId = null;

let currentLanguage = "en";
let voiceEnabled = true;

let lastGesture = "";
let lastGestureTime = 0;
let lastTTSTime = 0;
let lastTTSGesture = "";

let prevFrameTime = performance.now();

const gestureBuffer = [];

let noHandFrameCount = 0;
const NO_HAND_DEBOUNCE_FRAMES = 8;

// ─── NEW: Active camera source ────────────────────────────────────────────────

/** @type {LocalCameraSource | ESP32CameraSource | null} */
let activeSource = null;

// ─── Entry point ─────────────────────────────────────────────────────────────

async function init() {
    console.log("SpeechLess — Initialising...");

    setupEventListeners();

    voiceInfoEl.textContent = "Browser Voice TTS — English & Hindi";

    try {
        await initMediaPipe();
        console.log("MediaPipe HandLandmarker loaded");
    } catch (err) {
        console.error("Failed to load MediaPipe:", err);
        cameraOverlay.querySelector("p").textContent =
            "Failed to load AI model. Please refresh.";
        return;
    }

    // Default to local webcam on startup (same as before)
    try {
        await connectLocalWebcam();
    } catch (err) {
        // Error overlay already shown inside connectLocalWebcam
        return;
    }

    cameraOverlay.style.display = "none";
    startBtn.disabled = false;

    startDetection();
}

// ─── MediaPipe initialisation (UNCHANGED) ────────────────────────────────────

async function initMediaPipe() {
    const vision = await import(
        "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.18/vision_bundle.mjs"
    );

    const { HandLandmarker, FilesetResolver } = vision;

    const wasmFileset = await FilesetResolver.forVisionTasks(
        "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.18/wasm"
    );

    const modelAssetPath =
        "https://storage.googleapis.com/mediapipe-models/" +
        "hand_landmarker/hand_landmarker/float16/latest/" +
        "hand_landmarker.task";

    const commonOptions = {
        runningMode: "VIDEO",
        numHands: 1,
        minHandDetectionConfidence: 0.7,
        minHandPresenceConfidence: 0.7,
        minTrackingConfidence: 0.6,
    };

    try {
        handLandmarker = await HandLandmarker.createFromOptions(wasmFileset, {
            ...commonOptions,
            baseOptions: { modelAssetPath, delegate: "GPU" },
        });
        console.log("HandLandmarker: GPU delegate active");
    } catch (gpuErr) {
        console.warn("GPU delegate failed, falling back to CPU:", gpuErr.message);
        handLandmarker = await HandLandmarker.createFromOptions(wasmFileset, {
            ...commonOptions,
            baseOptions: { modelAssetPath, delegate: "CPU" },
        });
        console.log("HandLandmarker: CPU delegate active");
    }
}

// ─── Camera source management (NEW) ──────────────────────────────────────────

/**
 * Connect local webcam using LocalCameraSource.
 * Equivalent to the original initWebcam() call.
 */
async function connectLocalWebcam() {
    const esp32StreamEl = document.getElementById("esp32Stream");
    if (esp32StreamEl) {
        esp32StreamEl.style.display = "none";
        esp32StreamEl.src = "";
    }
    if (webcamEl) {
        webcamEl.style.display = "block";
    }

    if (activeSource) {
        activeSource.disconnect();
        activeSource = null;
    }

    const source = new LocalCameraSource(webcamEl);
    source.onStatusChange = (status, message) => {
        console.log(`[Camera] ${status}: ${message}`);
        if (status === SOURCE_STATUS.ERROR) {
            cameraOverlay.style.display = "none";
            errorOverlay.style.display  = "flex";
            setErrorOverlayMessage(message);
        }
    };

    await source.connect();
    activeSource = source;

    // Sync canvas size to video
    webcamEl.onloadedmetadata = () => {
        canvasEl.width  = webcamEl.videoWidth;
        canvasEl.height = webcamEl.videoHeight;
    };
    if (webcamEl.videoWidth) {
        canvasEl.width  = webcamEl.videoWidth;
        canvasEl.height = webcamEl.videoHeight;
    }
}

/**
 * Connect ESP32-CAM source.
 * Called when user clicks "Connect" in the ESP32 panel.
 */
async function connectESP32Cam(baseUrl) {
    setESP32Status("connecting", "Connecting...");
    esp32ConnectBtn.disabled = true;

    // Stop detection while switching source
    const wasDetecting = isDetecting;
    if (isDetecting) stopDetection();

    // Disconnect previous source
    if (activeSource) {
        activeSource.disconnect();
        activeSource = null;
    }

    const esp32StreamEl = document.getElementById("esp32Stream");
    const source = new ESP32CameraSource(esp32StreamEl, { debug: true });

    // Set activeSource immediately so detectFrame() doesn't fall back to dead webcamEl
    activeSource = source;

    source.onStatusChange = (status, message) => {
        console.log(`[ESP32Cam] ${status}: ${message}`);
        setESP32Status(status, message);

        if (status === SOURCE_STATUS.ERROR) {
            showCameraError(message);
        }
        if (status === SOURCE_STATUS.CONNECTED) {
            esp32ConnectBtn.textContent = "Disconnect";
            esp32ConnectBtn.disabled    = false;

            if (webcamEl) webcamEl.style.display = "none";
            if (esp32StreamEl) esp32StreamEl.style.display = "block";

            // Sync output canvas to source size immediately
            const src = source.getVideoElement();
            const w = (src && (src.naturalWidth || src.width)) || 320;
            const h = (src && (src.naturalHeight || src.height)) || 240;
            canvasEl.width  = w;
            canvasEl.height = h;

            startDetection();
        }
    };

    // Wire stats to debug panel
    source.onStats = (stats) => updateDebugPanel(stats);

    try {
        await source.connect(baseUrl);
    } catch (err) {
        console.error("[ESP32Cam] Connection failed:", err.message);
        activeSource = null;
        esp32ConnectBtn.textContent = "Connect";
        esp32ConnectBtn.disabled    = false;
        // Fall back to local webcam so the app still works
        try {
            await connectLocalWebcam();
            cameraSourceSelect.value = "local";
            esp32Panel.style.display = "none";
            if (wasDetecting) startDetection();
        } catch (_) { /* webcam also failed — overlay already shown */ }
    }
}

/** Disconnect the ESP32-CAM and fall back to local webcam. */
async function disconnectESP32Cam() {
    const wasDetecting = isDetecting;
    if (isDetecting) stopDetection();

    if (activeSource) {
        activeSource.disconnect();
        activeSource = null;
    }

    const esp32StreamEl = document.getElementById("esp32Stream");
    if (esp32StreamEl) {
        esp32StreamEl.style.display = "none";
        esp32StreamEl.src = "";
    }
    if (webcamEl) webcamEl.style.display = "block";

    setESP32Status("idle", "Disconnected");
    esp32ConnectBtn.textContent = "Connect";
    esp32ConnectBtn.disabled    = false;

    // Fall back to local webcam
    try {
        await connectLocalWebcam();
        if (wasDetecting) startDetection();
    } catch (err) {
        showCameraError(err.message);
    }
}

// ─── Detection loop (minimally modified) ─────────────────────────────────────

function startDetection() {
    if (isDetecting) return;
    isDetecting = true;

    startBtn.disabled = true;
    stopBtn.disabled  = false;

    gestureBuffer.length = 0;
    noHandFrameCount = 0;

    console.log("Detection started");
    detectFrame();
}


function stopDetection() {
    isDetecting = false;
    if (animationFrameId) {
        cancelAnimationFrame(animationFrameId);
        animationFrameId = null;
    }

    startBtn.disabled = false;
    stopBtn.disabled  = true;

    console.log("Detection stopped");
}


function detectFrame() {
    if (!isDetecting) return;

    const now = performance.now();

    // ── Get the current frame source ──────────────────────────────────────────
    // LocalCameraSource  → HTMLVideoElement
    // ESP32CameraSource  → HTMLCanvasElement (reusable offscreen canvas)
    const videoSource = activeSource ? activeSource.getVideoElement() : webcamEl;

    if (!videoSource) {
        animationFrameId = requestAnimationFrame(detectFrame);
        return;
    }

    const isVideo  = videoSource instanceof HTMLVideoElement;
    const isCanvas = videoSource instanceof HTMLCanvasElement;
    const isImage  = videoSource instanceof HTMLImageElement;

    if (isVideo && videoSource.readyState < 2) {
        animationFrameId = requestAnimationFrame(detectFrame);
        return;
    }
    if (isCanvas && (videoSource.width === 0 || videoSource.height === 0)) {
        animationFrameId = requestAnimationFrame(detectFrame);
        return;
    }
    if (isImage && (videoSource.naturalWidth === 0 || videoSource.naturalHeight === 0)) {
        animationFrameId = requestAnimationFrame(detectFrame);
        return;
    }

    // ═════════════════════════════════════════════════════════════════════════
    // PATH A: Local Webcam (UNCHANGED — Laptop webcam pipeline kept intact)
    // ═════════════════════════════════════════════════════════════════════════
    if (!activeSource || activeSource instanceof LocalCameraSource) {
        canvasCtx.save();
        canvasCtx.scale(-1, 1);
        canvasCtx.drawImage(videoSource, -canvasEl.width, 0, canvasEl.width, canvasEl.height);
        canvasCtx.restore();

        _mpFrameCount++;
        let results = null;
        try {
            results = handLandmarker.detectForVideo(videoSource, now);
        } catch (_) {}

        handleGesturePipeline(results, now);

        const fps = 1000 / (now - prevFrameTime + 0.1);
        prevFrameTime = now;
        fpsBadgeEl.textContent = `${Math.round(fps)} FPS`;

        animationFrameId = requestAnimationFrame(detectFrame);
        return;
    }

    // ═════════════════════════════════════════════════════════════════════════
    // PATH B: ESP32-CAM Decoupled Latest-Frame Pipeline (Requirements 2, 3, 6, 7)
    // ═════════════════════════════════════════════════════════════════════════

    try {
        // Dynamically match canvas internal dimensions to source natural dimensions
        const srcW = videoSource.naturalWidth || videoSource.width || 320;
        const srcH = videoSource.naturalHeight || videoSource.height || 240;
        if (srcW > 0 && (canvasEl.width !== srcW || canvasEl.height !== srcH)) {
            canvasEl.width  = srcW;
            canvasEl.height = srcH;
        }

        // 1. Decoupled Display: ALWAYS paint the freshest available frame to screen
        canvasCtx.save();
        canvasCtx.scale(-1, 1);
        canvasCtx.drawImage(videoSource, -canvasEl.width, 0, canvasEl.width, canvasEl.height);
        canvasCtx.restore();

        // Draw last confirmed landmarks on screen if not in stream-only mode
        if (lastTrackedLandmarks && !isStreamOnlyMode) {
            drawHandLandmarks(lastTrackedLandmarks);
        }

        // FPS badge represents rendering speed
        const fps = 1000 / (now - prevFrameTime + 0.1);
        prevFrameTime = now;
        fpsBadgeEl.textContent = isStreamOnlyMode
            ? `${Math.round(fps)} FPS (Stream Only)`
            : `${Math.round(fps)} FPS`;

        // 2. Stream-Only Mode Check (Requirement 15)
        // If stream-only mode is active, completely skip MediaPipe processing!
        if (isStreamOnlyMode) {
            animationFrameId = requestAnimationFrame(detectFrame);
            return;
        }

        // 3. Latest-Frame MediaPipe Scheduler
        // MediaPipe only runs when:
        //  • MediaPipe is NOT currently executing (isMediaPipeBusy === false)
        //  • Adaptive frame rate timer has elapsed (~10–15 FPS target)
        const currentFrameId = typeof activeSource.getFrameId === "function" ? activeSource.getFrameId() : 0;
        const isIntervalDue  = (now - lastMediaPipeRunTime) >= targetMediaPipeIntervalMs;

        if (!isMediaPipeBusy && isIntervalDue) {
            isMediaPipeBusy      = true;
            lastProcessedFrameId = currentFrameId;
            lastMediaPipeRunTime = now;

            if (typeof activeSource.recordMediaPipeProcessed === "function") {
                activeSource.recordMediaPipeProcessed();
            }

            const t0 = performance.now();
            try {
                // Strictly monotonic timestamp required by MediaPipe Tasks Vision
                const mpTimestamp = Math.max(now, lastMpTimestamp + 1);
                lastMpTimestamp = mpTimestamp;

                const results = handLandmarker.detectForVideo(videoSource, mpTimestamp);
                const duration = performance.now() - t0;
                mediaPipeDurationMs = Math.round(duration);

                // Adaptive frame-rate pacing:
                // Target stable 10–15 FPS. If MediaPipe takes 50ms, pace to ~66ms (15 FPS).
                // If MediaPipe takes 90ms, pace to ~110ms (~9–10 FPS) to prevent event loop starvation.
                targetMediaPipeIntervalMs = Math.max(66, Math.min(130, Math.round(duration * 1.2)));

                _mpFrameCount++;
                mpFramesProcessedCount++;

                handleGesturePipeline(results, now);
            } catch (err) {
                console.warn("[MediaPipe] Execution warning:", err.message);
            } finally {
                isMediaPipeBusy = false;
            }
        }
    } catch (err) {
        console.error("[DetectFrame] Render loop warning:", err);
    } finally {
        animationFrameId = requestAnimationFrame(detectFrame);
    }
}

/**
 * Handles landmark processing, finger detection, gesture majority voting, and TTS.
 * Shared between Local Webcam and ESP32-CAM.
 */
function handleGesturePipeline(results, now) {
    const handPresent =
        results &&
        results.landmarks &&
        results.landmarks.length > 0 &&
        isHandConfident(results);

    if (handPresent) {
        noHandFrameCount = 0;
        const landmarks = results.landmarks[0];
        lastTrackedLandmarks = landmarks;

        drawHandLandmarks(landmarks);

        const fingers = detectFingers(landmarks, results);
        updateFingerUI(fingers);

        const rawGesture = recogniseGesture(fingers);

        gestureBuffer.push(rawGesture);
        if (gestureBuffer.length > GESTURE_CONFIRM_FRAMES) gestureBuffer.shift();

        if (gestureBuffer.length === GESTURE_CONFIRM_FRAMES) {
            const confirmedGesture = getMajorityGesture(gestureBuffer);

            if (
                confirmedGesture &&
                (now - lastGestureTime > GESTURE_COOLDOWN_MS || confirmedGesture !== lastGesture)
            ) {
                updateGestureDisplay(confirmedGesture);
                lastGesture     = confirmedGesture;
                lastGestureTime = now;

                if (
                    voiceEnabled &&
                    (now - lastTTSTime > TTS_COOLDOWN_MS || confirmedGesture !== lastTTSGesture)
                ) {
                    triggerTTS(confirmedGesture);
                    lastTTSTime    = now;
                    lastTTSGesture = confirmedGesture;
                }
            }
        }
    } else {
        lastTrackedLandmarks = null;
        noHandFrameCount++;
        if (noHandFrameCount >= NO_HAND_DEBOUNCE_FRAMES) {
            gestureBuffer.length = 0;
            updateFingerUI([false, false, false, false, false]);
        }
    }
}

// ─── Gesture recognition helpers (UNCHANGED) ─────────────────────────────────

function isHandConfident(results) {
    if (results.handedness && results.handedness.length > 0) {
        const score = results.handedness[0][0]?.score ?? 1.0;
        return score >= MIN_HAND_PRESENCE_CONFIDENCE;
    }
    return true;
}


function getMajorityGesture(buffer) {
    const counts = {};
    let maxCount = 0;
    let majority = null;

    for (const key of buffer) {
        if (key === null) continue;
        counts[key] = (counts[key] || 0) + 1;
        if (counts[key] > maxCount) {
            maxCount = counts[key];
            majority = key;
        }
    }

    return maxCount > buffer.length / 2 ? majority : null;
}


function drawHandLandmarks(landmarks) {
    const w = canvasEl.width;
    const h = canvasEl.height;

    const points = landmarks.map(lm => ({
        x: (1.0 - lm.x) * w,
        y: lm.y * h,
    }));

    canvasCtx.strokeStyle = "rgba(0, 109, 104, 0.75)";
    canvasCtx.lineWidth = 2.5;

    for (const [start, end] of HAND_CONNECTIONS) {
        canvasCtx.beginPath();
        canvasCtx.moveTo(points[start].x, points[start].y);
        canvasCtx.lineTo(points[end].x, points[end].y);
        canvasCtx.stroke();
    }

    for (let i = 0; i < points.length; i++) {
        const { x, y } = points[i];
        const isTip = [4, 8, 12, 16, 20].includes(i);

        canvasCtx.beginPath();
        canvasCtx.arc(x, y, isTip ? 6 : 3.5, 0, 2 * Math.PI);
        canvasCtx.fillStyle = isTip ? "#F0EDE5" : "rgba(0, 109, 104, 0.9)";
        canvasCtx.fill();

        canvasCtx.strokeStyle = "#004643";
        canvasCtx.lineWidth = 1.5;
        canvasCtx.stroke();
    }
}


const fingerStates = [false, false, false, false, false];

function landmarkDist(a, b) {
    const dx = a.x - b.x;
    const dy = a.y - b.y;
    const dz = (a.z || 0) - (b.z || 0);
    return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

function detectFingers(landmarks, results) {
    if (!landmarks || landmarks.length < 21) return [false, false, false, false, false];

    let isRightHandModel = true;
    if (results && results.handedness && results.handedness.length > 0) {
        const label = results.handedness[0][0]?.categoryName ?? "Right";
        isRightHandModel = (label === "Right");
    }

    const handSize   = landmarkDist(landmarks[0], landmarks[9]);
    const thumbSpan  = landmarkDist(landmarks[4], landmarks[5]);
    const thumbRatio = handSize > 0.01 ? thumbSpan / handSize : 0;

    const thumbGoUp   = 0.48;
    const thumbGoDown = 0.32;

    if (fingerStates[0]) {
        if (thumbRatio < thumbGoDown) fingerStates[0] = false;
    } else {
        if (thumbRatio > thumbGoUp)   fingerStates[0] = true;
    }

    const fingerLandmarks = [
        [5,  6,  7,  8],
        [9,  10, 11, 12],
        [13, 14, 15, 16],
        [17, 18, 19, 20],
    ];

    const goUpRatio   = 1.6;
    const goDownRatio = 1.2;

    for (let i = 0; i < fingerLandmarks.length; i++) {
        const [mcp, pip, , tip] = fingerLandmarks[i];
        const fingerLen  = landmarkDist(landmarks[mcp], landmarks[tip]);
        const fingerBase = landmarkDist(landmarks[mcp], landmarks[pip]);

        if (fingerBase < 0.001) continue;

        const curlRatio = fingerLen / fingerBase;
        const stateIdx  = i + 1;

        const tipAbovePip = landmarks[tip].y < landmarks[pip].y;

        if (fingerStates[stateIdx]) {
            if (curlRatio < goDownRatio || !tipAbovePip) {
                fingerStates[stateIdx] = false;
            }
        } else {
            if (curlRatio > goUpRatio && tipAbovePip) {
                fingerStates[stateIdx] = true;
            }
        }
    }

    return [...fingerStates];
}

function recogniseGesture(fingers) {
    const key = fingers.map(f => f ? "1" : "0").join("");
    return GESTURE_MAP[key] || null;
}

// ─── UI update helpers (UNCHANGED) ───────────────────────────────────────────

function updateFingerUI(fingers) {
    const names = ["thumb", "index", "middle", "ring", "pinky"];
    names.forEach((name, i) => {
        const el      = fingerEls[name];
        const stateEl = el.querySelector(".finger-state");
        const isUp    = fingers[i];
        el.classList.toggle("active", isUp);
        if (stateEl) {
            stateEl.textContent = isUp ? "UP" : "DOWN";
            stateEl.style.color = isUp ? "var(--finger-up)" : "var(--text-muted)";
        }
    });
}

function updateGestureDisplay(gesture) {
    const langMap    = TRANSLATIONS[currentLanguage] || TRANSLATIONS.en;
    const translated = langMap[gesture] || gesture;

    gestureTextEl.textContent    = gesture;
    translatedTextEl.textContent = currentLanguage !== "en" ? translated : "";

    gestureTextEl.classList.remove("pulse");
    void gestureTextEl.offsetWidth;
    gestureTextEl.classList.add("pulse");

    subtitleTextEl.textContent = currentLanguage === "en"
        ? gesture
        : `${translated} (${gesture})`;
    subtitleTextEl.classList.add("active");
    setTimeout(() => subtitleTextEl.classList.remove("active"), 1500);

    console.log(`[GESTURE] ${gesture} -> ${translated}`);
}

// ─── TTS (UNCHANGED) ─────────────────────────────────────────────────────────

function triggerTTS(gesture) {
    const langMap    = TRANSLATIONS[currentLanguage] || TRANSLATIONS.en;
    const textToSpeak = langMap[gesture] || gesture;
    speakBrowser(textToSpeak, currentLanguage);
}

function speakBrowser(text, language) {
    if (!("speechSynthesis" in window)) {
        console.warn("Browser does not support speech synthesis.");
        return;
    }
    window.speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(text);
    const langCodes = { en: "en-US", hi: "hi-IN" };
    utterance.lang   = langCodes[language] || "en-US";
    utterance.rate   = 0.9;
    utterance.pitch  = 1.0;
    utterance.volume = 1.0;
    utterance.onstart = () => updateVoiceStatus("speaking", "Speaking...");
    utterance.onend   = () => updateVoiceStatus("ready",    "Ready");
    utterance.onerror = () => updateVoiceStatus("ready",    "Ready");
    window.speechSynthesis.speak(utterance);
}

function updateVoiceStatus(state, text) {
    voiceStatusText.textContent = text;
    statusDotEl.classList.remove("speaking", "error");
    if (state === "speaking") statusDotEl.classList.add("speaking");
    else if (state === "error") statusDotEl.classList.add("error");
}

// ─── ESP32-CAM UI helpers ─────────────────────────────────────────────────────

function setESP32Status(status, message) {
    if (!esp32StatusDot || !esp32StatusText) return;
    esp32StatusDot.className = "esp32-status-dot";
    const map = {
        [SOURCE_STATUS.IDLE]:       "esp32-status-dot--idle",
        [SOURCE_STATUS.CONNECTING]: "esp32-status-dot--connecting",
        [SOURCE_STATUS.CONNECTED]:  "esp32-status-dot--connected",
        [SOURCE_STATUS.ERROR]:      "esp32-status-dot--error",
    };
    if (map[status]) esp32StatusDot.classList.add(map[status]);
    esp32StatusText.textContent = message;
}

function showCameraError(message) {
    cameraOverlay.style.display = "none";
    errorOverlay.style.display  = "flex";
    setErrorOverlayMessage(message);
}

function setErrorOverlayMessage(msg) {
    const p = errorOverlay.querySelector("p:nth-child(2)");
    if (p) p.textContent = msg;
}

/**
 * Update the debug panel with the latest stream statistics.
 * Called by ESP32CameraSource.onStats every second.
 * @param {{ fps, decodedFps, droppedFrames, totalReceived, totalDecoded, totalDropped, latencyMs, jpegKb, source, rssi }} stats
 */
function updateDebugPanel(stats) {
    if (!debugPanel || debugPanel.style.display === "none") return;
    if (dbgConn)      dbgConn.textContent      = activeSource && activeSource.getStatus() === SOURCE_STATUS.CONNECTED ? "Connected" : "Idle";
    if (dbgFps)       dbgFps.textContent       = `${stats.fps} FPS`;
    if (dbgLatency)   dbgLatency.textContent   = `${stats.latencyMs} ms`;
    if (dbgJpegKb)    dbgJpegKb.textContent    = `${stats.jpegKb} KB`;
    if (dbgReceived)  dbgReceived.textContent  = `${stats.totalReceived}`;
    if (dbgProcessed) dbgProcessed.textContent = `${mpFramesProcessedCount}`;
    if (dbgDropped)   dbgDropped.textContent   = `${stats.totalDropped}`;
    if (dbgSource)    dbgSource.textContent    = stats.source;
    if (dbgMpFps)     dbgMpFps.textContent     = `${_mpFps} FPS`;
    if (dbgMpTime)    dbgMpTime.textContent    = `${mediaPipeDurationMs} ms`;
    if (dbgRssi && stats.rssi) dbgRssi.textContent = `${stats.rssi} dBm`;
}

// ─── Event listeners (extended from original) ─────────────────────────────────

function setupEventListeners() {
    // ── Original controls (UNCHANGED) ─────────────────────────────────────────
    startBtn.addEventListener("click", startDetection);
    stopBtn.addEventListener("click", stopDetection);

    voiceToggleEl.addEventListener("click", () => {
        voiceEnabled = !voiceEnabled;
        voiceToggleEl.textContent = voiceEnabled ? "Voice On" : "Voice Off";
        voiceToggleEl.classList.toggle("btn-accent",    voiceEnabled);
        voiceToggleEl.classList.toggle("btn-secondary", !voiceEnabled);
    });

    languageSelectEl.addEventListener("change", (e) => {
        currentLanguage = e.target.value;
        console.log("Language changed to:", currentLanguage);
        if (lastGesture) updateGestureDisplay(lastGesture);
    });

    guideToggleEl.addEventListener("click", () => {
        const panel = guidePanelEl;
        panel.style.display = panel.style.display === "none" ? "block" : "none";
    });

    document.addEventListener("click", (e) => {
        if (!guidePanelEl.contains(e.target) && e.target !== guideToggleEl) {
            guidePanelEl.style.display = "none";
        }
    });

    // ── Camera source selector (NEW) ──────────────────────────────────────────
    if (cameraSourceSelect) {
        cameraSourceSelect.addEventListener("change", async (e) => {
            const val = e.target.value;

            if (val === "local") {
                // Switch to webcam
                esp32Panel.style.display = "none";
                if (activeSource && !(activeSource instanceof LocalCameraSource)) {
                    const wasDetecting = isDetecting;
                    if (isDetecting) stopDetection();
                    activeSource.disconnect();
                    activeSource = null;
                    try {
                        cameraOverlay.style.display = "flex";
                        await connectLocalWebcam();
                        cameraOverlay.style.display = "none";
                        if (wasDetecting) startDetection();
                    } catch (err) {
                        showCameraError(err.message);
                    }
                }
            } else if (val === "esp32") {
                // Show ESP32 panel
                esp32Panel.style.display = "block";
                const savedIp = localStorage.getItem("esp32_cam_url");
                if (savedIp && esp32UrlInput) esp32UrlInput.value = savedIp;
            }
        });
    }

    // ── ESP32 Connect / Disconnect button (NEW) ───────────────────────────────
    if (esp32ConnectBtn) {
        esp32ConnectBtn.addEventListener("click", async () => {
            // Toggle: if already connected via ESP32, disconnect
            if (
                activeSource instanceof ESP32CameraSource &&
                activeSource.getStatus() === SOURCE_STATUS.CONNECTED
            ) {
                await disconnectESP32Cam();
                return;
            }

            const url = esp32UrlInput.value.trim();
            if (!url) {
                setESP32Status("error", "Please enter the ESP32-CAM IP address.");
                return;
            }
            localStorage.setItem("esp32_cam_url", url);
            await connectESP32Cam(url);
        });
    }

    // ── Allow pressing Enter in URL field to connect ──────────────────────────
    if (esp32UrlInput) {
        esp32UrlInput.addEventListener("keydown", (e) => {
            if (e.key === "Enter") esp32ConnectBtn.click();
        });
    }

    // ── Stream Mode Toggles (Requirement 15: Stream-Only vs AI Tracking) ─────
    if (modeAiBtn && modeStreamOnlyBtn) {
        modeAiBtn.addEventListener("click", () => {
            isStreamOnlyMode = false;
            modeAiBtn.classList.add("active");
            modeStreamOnlyBtn.classList.remove("active");
            console.log("[ESP32] Mode switched to: AI Hand Tracking");
        });
        modeStreamOnlyBtn.addEventListener("click", () => {
            isStreamOnlyMode = true;
            modeStreamOnlyBtn.classList.add("active");
            modeAiBtn.classList.remove("active");
            lastTrackedLandmarks = null;
            gestureBuffer.length = 0;
            updateFingerUI([false, false, false, false, false]);
            console.log("[ESP32] Mode switched to: Stream-Only Test (Display only, MediaPipe bypassed)");
        });
    }

    // ── Debug panel toggle (Requirement 14) ───────────────────────────────────
    if (debugToggleBtn && debugPanel) {
        debugToggleBtn.addEventListener("click", () => {
            const hidden = debugPanel.style.display === "none" || !debugPanel.style.display;
            debugPanel.style.display = hidden ? "block" : "none";

            // Poll RSSI from /status when panel opens
            if (hidden && activeSource instanceof ESP32CameraSource) {
                const base = esp32UrlInput ? esp32UrlInput.value.trim() : "";
                if (base) {
                    fetch(`${base.replace(/\/+$/, "")}/status`, { mode: "cors", cache: "no-store" })
                        .then(r => r.json())
                        .then(j => { if (dbgRssi && typeof j.rssi_dbm === "number") dbgRssi.textContent = `${j.rssi_dbm} dBm`; })
                        .catch(() => { if (dbgRssi) dbgRssi.textContent = "—"; });
                }
            }
        });
    }

    // ── Benchmark Runner (Requirement 16) ─────────────────────────────────────
    if (runBenchmarkBtn) {
        runBenchmarkBtn.addEventListener("click", async () => {
            if (!activeSource || !(activeSource instanceof ESP32CameraSource)) {
                alert("Please connect to ESP32-CAM before running benchmark.");
                return;
            }
            runBenchmarkBtn.disabled = true;
            runBenchmarkBtn.textContent = "Running Benchmark (5s)...";
            if (benchmarkResult) {
                benchmarkResult.style.display = "block";
                benchmarkResult.textContent = "Measuring frame arrivals and intervals for 5 seconds...";
            }

            try {
                const report = await activeSource.runBenchmark(5);
                if (benchmarkResult) {
                    benchmarkResult.textContent =
`BENCHMARK REPORT (5-second test)
───────────────────────────────────
Total Received:   ${report.totalReceived} frames
Total Decoded:    ${report.totalDecoded} frames
Dropped Stale:    ${report.droppedFrames} frames (${report.dropRatePct}%)
Stream FPS (Avg): ${report.avgFps} FPS
FPS Range:        ${report.minFps} – ${report.maxFps} FPS
Average Payload:  ${report.avgJpegKb} KB / frame
Hardware Decode:  ${report.avgDecodeMs} ms / frame
Wi-Fi Signal:     ${report.rssi} dBm
MediaPipe Mode:   ${isStreamOnlyMode ? "Stream-Only (Off)" : "AI Tracking (Active)"}
MediaPipe Time:   ${mediaPipeDurationMs} ms
Status:           Smooth (Latest-Frame Architecture)`;
                }
            } catch (err) {
                if (benchmarkResult) benchmarkResult.textContent = `Benchmark failed: ${err.message}`;
            } finally {
                runBenchmarkBtn.disabled = false;
                runBenchmarkBtn.textContent = "Run FPS Benchmark (5s)";
            }
        });
    }
}

// ─── Start ────────────────────────────────────────────────────────────────────

init();
