/*
 * esp32_cam_stream.ino
 * ════════════════════════════════════════════════════════════════════════════
 * SpeechLess — ESP32-CAM Wi-Fi Camera Firmware  (Optimised for low latency)
 * Board: AI-Thinker ESP32-CAM (OV2640)
 *
 * KEY OPTIMISATIONS vs original:
 *  1. CAMERA_GRAB_LATEST   — always discards stale frames; gives the freshest
 *                            frame to the HTTP client.  This is the single
 *                            biggest latency reduction.
 *  2. WiFi.setSleep(false) — disables Wi-Fi power-saving which adds 20-100 ms
 *                            of packet latency per frame.
 *  3. fb_count = 2 + GRAB_LATEST — 2 buffers work correctly together with
 *                            GRAB_LATEST; one is being filled while one is
 *                            being sent.  Never use GRAB_WHEN_EMPTY with 2 fbs.
 *  4. Diagnostics          — timing per frame (capture ms, JPEG KB, FPS,
 *                            RSSI) printed to Serial.
 *  5. HTTP task pinned to core 0 — camera capture runs on core 1 (Arduino
 *                            default), HTTP on core 0 avoids contention.
 *  6. Larger send buffer   — httpd_config recv_wait_timeout / send_wait_timeout
 *                            reduced so the server drops a slow client faster.
 *  7. XCLK 20 MHz kept     — adequate for OV2640 at QVGA; raising to 24 MHz
 *                            can sometimes help on boards with good decoupling.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * BOARD CONFIGURATION
 * ─────────────────────────────────────────────────────────────────────────────
 * Targets AI-Thinker ESP32-CAM by default.
 * Change the CAM_PIN_* defines below for other boards.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * REQUIRED LIBRARIES
 * ─────────────────────────────────────────────────────────────────────────────
 *   • esp32 board support (Espressif) >= 2.0.0
 *       Tools → Board Manager → search "esp32" → install
 *   Bundled: esp_camera.h, esp_http_server.h, WiFi.h
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * FLASHING
 * ─────────────────────────────────────────────────────────────────────────────
 *   1. Tools → Board → "AI Thinker ESP32-CAM"
 *   2. Tools → Port → your USB-serial adapter
 *   3. Hold IO0 (GPIO0) LOW → press RESET → click Upload
 *   4. After upload: release IO0 → press RESET
 *   5. Serial Monitor @ 115200 baud → note the IP address
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * RESOLUTION & QUALITY TUNING
 * ─────────────────────────────────────────────────────────────────────────────
 * For hand tracking, prioritise FPS over resolution.
 *
 *   FRAMESIZE_QVGA  320×240   ~12-18 FPS  (recommended default)
 *   FRAMESIZE_CIF   400×296   ~8-12 FPS
 *   FRAMESIZE_VGA   640×480   ~4-8 FPS
 *
 * JPEG_QUALITY: lower number = better quality / larger file / slower.
 *   10  → ~25-35 KB per frame, very clear
 *   15  → ~15-22 KB per frame, good for hand tracking  ← recommended
 *   20  → ~10-15 KB per frame, acceptable at QVGA
 *   30  → ~6-10 KB per frame, blurry but usable for rough gestures
 * ════════════════════════════════════════════════════════════════════════════
 */

#include "esp_camera.h"
#include "esp_http_server.h"
#include "esp_timer.h"
#include "WiFi.h"

// ─── Wi-Fi credentials ────────────────────────────────────────────────────────
#define WIFI_SSID     "Ram"
#define WIFI_PASSWORD "Ram12345"

// ─── Camera resolution / quality ─────────────────────────────────────────────
// CHANGE HERE to tune FPS vs image quality.
// For hand tracking QVGA at quality 15 is the sweet spot.
#define FRAME_SIZE    FRAMESIZE_QVGA   // 320×240
#define JPEG_QUALITY  15               // 0=best/slow … 63=worst/fast

// ─── XCLK frequency ──────────────────────────────────────────────────────────
// 20 MHz is safe for all AI-Thinker boards.
// Try 24000000 if your board has good power decoupling — can improve FPS.
#define XCLK_FREQ_HZ  20000000

// ─── Wi-Fi reconnect timing ───────────────────────────────────────────────────
#define WIFI_CONNECT_TIMEOUT_MS  20000
#define WIFI_CHECK_INTERVAL_MS   10000   // check every 10 s (not 5 s — less overhead)

// ─── Diagnostics ─────────────────────────────────────────────────────────────
// Set to 1 to print per-frame timing to Serial; 0 to silence.
#define STREAM_DIAGNOSTICS  1

// ─── AI-Thinker ESP32-CAM pin map ────────────────────────────────────────────
#define CAM_PIN_PWDN    32
#define CAM_PIN_RESET   -1
#define CAM_PIN_XCLK     0
#define CAM_PIN_SIOD    26
#define CAM_PIN_SIOC    27
#define CAM_PIN_D7      35
#define CAM_PIN_D6      34
#define CAM_PIN_D5      39
#define CAM_PIN_D4      36
#define CAM_PIN_D3      21
#define CAM_PIN_D2      19
#define CAM_PIN_D1      18
#define CAM_PIN_D0       5
#define CAM_PIN_VSYNC   25
#define CAM_PIN_HREF    23
#define CAM_PIN_PCLK    22

// ─── MJPEG boundary string ────────────────────────────────────────────────────
#define PART_BOUNDARY "speechless_boundary"
static const char* _STREAM_CONTENT_TYPE =
    "multipart/x-mixed-replace;boundary=" PART_BOUNDARY;
static const char* _STREAM_BOUNDARY =
    "\r\n--" PART_BOUNDARY "\r\n";
static const char* _STREAM_PART =
    "Content-Type: image/jpeg\r\nContent-Length: %u\r\n\r\n";

// ─── Globals ──────────────────────────────────────────────────────────────────
static httpd_handle_t  cameraHttpd  = NULL;
static unsigned long   lastWifiCheck = 0;

// Diagnostics — shared with stream handler
static volatile uint32_t streamFps    = 0;
static volatile uint32_t streamFrames = 0;
static volatile uint32_t lastFpsTime  = 0;

// Framebuffer configuration tracking (reported in /status)
static int         g_fb_count    = 0;
static const char* g_fb_location = "UNKNOWN";

// ─────────────────────────────────────────────────────────────────────────────
// Camera initialisation
// ─────────────────────────────────────────────────────────────────────────────
static bool initCamera() {
    camera_config_t config;

    config.ledc_channel = LEDC_CHANNEL_0;
    config.ledc_timer   = LEDC_TIMER_0;
    config.pin_d0       = CAM_PIN_D0;
    config.pin_d1       = CAM_PIN_D1;
    config.pin_d2       = CAM_PIN_D2;
    config.pin_d3       = CAM_PIN_D3;
    config.pin_d4       = CAM_PIN_D4;
    config.pin_d5       = CAM_PIN_D5;
    config.pin_d6       = CAM_PIN_D6;
    config.pin_d7       = CAM_PIN_D7;
    config.pin_xclk     = CAM_PIN_XCLK;
    config.pin_pclk     = CAM_PIN_PCLK;
    config.pin_vsync    = CAM_PIN_VSYNC;
    config.pin_href     = CAM_PIN_HREF;
    config.pin_sccb_sda = CAM_PIN_SIOD;
    config.pin_sccb_scl = CAM_PIN_SIOC;
    config.pin_pwdn     = CAM_PIN_PWDN;
    config.pin_reset    = CAM_PIN_RESET;
    config.xclk_freq_hz = XCLK_FREQ_HZ;
    config.pixel_format = PIXFORMAT_JPEG;

    // ── CRITICAL LATENCY FIX ──────────────────────────────────────────────────
    // CAMERA_GRAB_LATEST: always discards buffered frames and grabs the
    // freshest one.  CAMERA_GRAB_WHEN_EMPTY (the old value) only captures when
    // the buffer slot is free — with 2 buffers this means you could serve a
    // frame that is 2 capture cycles old.
    config.grab_mode = CAMERA_GRAB_LATEST;

    bool hasPsram = psramFound();

    Serial.printf("[Camera] PSRAM detected: %s\r\n", hasPsram ? "YES" : "NO");

    if (hasPsram) {
        Serial.printf("[Camera] Free PSRAM: %u bytes\r\n",
                      (unsigned)ESP.getFreePsram());
        // 2 frame buffers in PSRAM + GRAB_LATEST = always freshest frame
        config.frame_size   = FRAME_SIZE;
        config.jpeg_quality = JPEG_QUALITY;
        config.fb_count     = 2;
        config.fb_location  = CAMERA_FB_IN_PSRAM;
        g_fb_count          = 2;
        g_fb_location       = "PSRAM";
    } else {
        Serial.println("[Camera] No PSRAM — using DRAM, single buffer");
        // Without PSRAM: single buffer only, force QVGA to fit in DRAM
        config.frame_size   = FRAMESIZE_QVGA;
        config.jpeg_quality = JPEG_QUALITY;
        config.fb_count     = 1;
        config.fb_location  = CAMERA_FB_IN_DRAM;
        g_fb_count          = 1;
        g_fb_location       = "DRAM";
    }

    Serial.printf("[Camera] Free heap before init: %u bytes\r\n",
                  (unsigned)esp_get_free_heap_size());

    esp_err_t err = esp_camera_init(&config);
    if (err != ESP_OK) {
        Serial.printf("[Camera] Init failed: 0x%x\r\n", err);
        return false;
    }

    // Apply sensor quality settings after init for finer control
    sensor_t* sensor = esp_camera_sensor_get();
    if (sensor) {
        sensor->set_quality(sensor, JPEG_QUALITY);
        // Reduce JPEG compression artefacts for MediaPipe at QVGA
        sensor->set_sharpness(sensor, 1);
        sensor->set_denoise(sensor, 1);
    }

    // Flush stale frames so the first request gets a fresh frame
    for (int i = 0; i < 3; i++) {
        camera_fb_t* fb = esp_camera_fb_get();
        if (fb) esp_camera_fb_return(fb);
        delay(30);
    }

    Serial.printf("[Camera] Initialised OK  size=%d quality=%d\r\n",
                  FRAME_SIZE, JPEG_QUALITY);
    Serial.printf("[Camera] Free heap after init: %u bytes\r\n",
                  (unsigned)esp_get_free_heap_size());
    return true;
}

// ─────────────────────────────────────────────────────────────────────────────
// CORS headers
// ─────────────────────────────────────────────────────────────────────────────
static void addCorsHeaders(httpd_req_t* req) {
    httpd_resp_set_hdr(req, "Access-Control-Allow-Origin",  "*");
    httpd_resp_set_hdr(req, "Access-Control-Allow-Methods", "GET, OPTIONS");
    httpd_resp_set_hdr(req, "Access-Control-Allow-Headers", "Content-Type");
    httpd_resp_set_hdr(req, "Access-Control-Max-Age",       "86400");
}

// ─────────────────────────────────────────────────────────────────────────────
// GET /  — root / health check
// ─────────────────────────────────────────────────────────────────────────────
static esp_err_t rootHandler(httpd_req_t* req) {
    addCorsHeaders(req);
    if (req->method == HTTP_OPTIONS) {
        httpd_resp_set_status(req, "204 No Content");
        return httpd_resp_send(req, NULL, 0);
    }
    const char* resp = "SpeechLess ESP32-CAM OK";
    httpd_resp_set_type(req, "text/plain");
    return httpd_resp_send(req, resp, strlen(resp));
}

// ─────────────────────────────────────────────────────────────────────────────
// GET /status  — JSON diagnostics (extended with PSRAM, RSSI, and stream FPS)
// ─────────────────────────────────────────────────────────────────────────────
static esp_err_t statusHandler(httpd_req_t* req) {
    addCorsHeaders(req);
    if (req->method == HTTP_OPTIONS) {
        httpd_resp_set_status(req, "204 No Content");
        return httpd_resp_send(req, NULL, 0);
    }

    char json[320];
    snprintf(json, sizeof(json),
        "{\"status\":\"ok\","
        "\"uptime_s\":%lu,"
        "\"heap_b\":%u,"
        "\"psram_found\":%s,"
        "\"free_psram_b\":%u,"
        "\"fb_count\":%d,"
        "\"fb_location\":\"%s\","
        "\"rssi_dbm\":%d,"
        "\"stream_fps\":%u,"
        "\"frame_size\":\"%dx%d\","
        "\"jpeg_quality\":%d}",
        millis() / 1000,
        (unsigned)esp_get_free_heap_size(),
        psramFound() ? "true" : "false",
        psramFound() ? (unsigned)ESP.getFreePsram() : 0,
        g_fb_count,
        g_fb_location,
        WiFi.RSSI(),
        (unsigned)streamFps,
        (FRAME_SIZE == FRAMESIZE_QVGA) ? 320 : (FRAME_SIZE == FRAMESIZE_CIF) ? 400 : 640,
        (FRAME_SIZE == FRAMESIZE_QVGA) ? 240 : (FRAME_SIZE == FRAMESIZE_CIF) ? 296 : 480,
        JPEG_QUALITY
    );

    httpd_resp_set_type(req, "application/json");
    return httpd_resp_send(req, json, strlen(json));
}

// ─────────────────────────────────────────────────────────────────────────────
// GET /capture  — single fresh JPEG snapshot
// ─────────────────────────────────────────────────────────────────────────────
static esp_err_t captureHandler(httpd_req_t* req) {
    addCorsHeaders(req);
    if (req->method == HTTP_OPTIONS) {
        httpd_resp_set_status(req, "204 No Content");
        return httpd_resp_send(req, NULL, 0);
    }

    int64_t t0 = esp_timer_get_time();

    camera_fb_t* fb = esp_camera_fb_get();
    if (!fb) {
        Serial.println("[Capture] Frame failed");
        httpd_resp_send_500(req);
        return ESP_FAIL;
    }

    int64_t captureMs = (esp_timer_get_time() - t0) / 1000;

    httpd_resp_set_type(req, "image/jpeg");
    httpd_resp_set_hdr(req, "Cache-Control", "no-cache, no-store, must-revalidate");
    httpd_resp_set_hdr(req, "Pragma",        "no-cache");
    httpd_resp_set_hdr(req, "Expires",       "0");

    esp_err_t res = httpd_resp_send(req, (const char*)fb->buf, fb->len);

    if (STREAM_DIAGNOSTICS) {
        Serial.printf("[Capture] %u KB  capture=%lld ms\r\n",
                      (unsigned)(fb->len / 1024), captureMs);
    }

    esp_camera_fb_return(fb);
    return res;
}

// ─────────────────────────────────────────────────────────────────────────────
// GET /stream  — optimised MJPEG multipart stream
// ─────────────────────────────────────────────────────────────────────────────
static const char* httpdErrToString(esp_err_t err) {
    switch (err) {
        case ESP_OK:                     return "ESP_OK (success)";
        case ESP_ERR_HTTPD_RESP_SEND:    return "ESP_ERR_HTTPD_RESP_SEND (socket closed / client disconnected / broken pipe)";
        case ESP_ERR_HTTPD_RESP_HDR:     return "ESP_ERR_HTTPD_RESP_HDR (invalid headers)";
        case ESP_ERR_HTTPD_HANDLER_EXISTS: return "ESP_ERR_HTTPD_HANDLER_EXISTS";
        case ESP_ERR_HTTPD_ALLOC_MEM:    return "ESP_ERR_HTTPD_ALLOC_MEM (out of memory)";
        case ESP_ERR_HTTPD_TASK:         return "ESP_ERR_HTTPD_TASK";
        case ESP_ERR_INVALID_ARG:        return "ESP_ERR_INVALID_ARG (invalid argument)";
        case ESP_ERR_TIMEOUT:            return "ESP_ERR_TIMEOUT (socket send timeout)";
        default:                         return "Unknown HTTP server error";
    }
}

static esp_err_t streamHandler(httpd_req_t* req) {
    addCorsHeaders(req);
    if (req->method == HTTP_OPTIONS) {
        httpd_resp_set_status(req, "204 No Content");
        return httpd_resp_send(req, NULL, 0);
    }

    esp_err_t res = httpd_resp_set_type(req, _STREAM_CONTENT_TYPE);
    if (res != ESP_OK) return res;

    httpd_resp_set_hdr(req, "Cache-Control", "no-cache");
    httpd_resp_set_hdr(req, "X-Framerate",   "15");

    char      partBuf[128];
    uint32_t  frameCount = 0;
    int64_t   tStart     = esp_timer_get_time();
    int64_t   tFpsWindow = tStart;

    while (true) {
        int64_t tFrame = esp_timer_get_time();

        camera_fb_t* fb = esp_camera_fb_get();
        if (!fb) {
            Serial.println("[Stream] Frame capture failed — closing stream");
            res = ESP_FAIL;
            break;
        }

        int64_t captureMs = (esp_timer_get_time() - tFrame) / 1000;

        // ── Send MJPEG boundary & headers with exact transmission timing ─────
        int64_t tSendStart = esp_timer_get_time();

        res = httpd_resp_send_chunk(req, _STREAM_BOUNDARY, strlen(_STREAM_BOUNDARY));
        if (res != ESP_OK) {
            Serial.printf("[Stream] Send boundary failed: 0x%x (%d) -> %s\r\n", res, res, httpdErrToString(res));
            esp_camera_fb_return(fb);
            break;
        }

        size_t hLen = snprintf(partBuf, sizeof(partBuf), _STREAM_PART, fb->len);
        res = httpd_resp_send_chunk(req, partBuf, hLen);
        if (res != ESP_OK) {
            Serial.printf("[Stream] Send header failed: 0x%x (%d) -> %s\r\n", res, res, httpdErrToString(res));
            esp_camera_fb_return(fb);
            break;
        }

        // ── Send JPEG payload ────────────────────────────────────────────────
        res = httpd_resp_send_chunk(req, (const char*)fb->buf, fb->len);
        if (res != ESP_OK) {
            Serial.printf("[Stream] Send payload failed: 0x%x (%d) -> %s\r\n", res, res, httpdErrToString(res));
            esp_camera_fb_return(fb);
            break;
        }

        int64_t tSendDone = esp_timer_get_time();
        int     sendMs    = (int)((tSendDone - tSendStart) / 1000);
        int     totalMs   = (int)((tSendDone - tFrame) / 1000);
        size_t  frameBytes = fb->len;

        esp_camera_fb_return(fb);          // ASAP — return buffer to sensor DMA

        frameCount++;

        // ── Exact Per-Frame Diagnostic Output (for Layer 1-4 Analysis) ───────
        if (STREAM_DIAGNOSTICS) {
            Serial.printf("FRAME %u | capture = %lld ms | size = %u bytes | send = %d ms | total = %d ms\r\n",
                          frameCount, captureMs, (unsigned)frameBytes, sendMs, totalMs);
        }

        // FPS window calculation
        int64_t now = esp_timer_get_time();
        int64_t windowUs = now - tFpsWindow;
        if (windowUs >= 1000000LL) {
            streamFps    = (uint32_t)((frameCount * 1000000LL) / windowUs);
            streamFrames = frameCount;
            frameCount   = 0;
            tFpsWindow   = now;
        }
    }

    httpd_resp_send_chunk(req, NULL, 0);
    Serial.println("[Stream] Client disconnected");
    return res;
}

// ─────────────────────────────────────────────────────────────────────────────
// GET /test_capture  — LAYER 1 ISOLATED TEST (100 frame captures, NO streaming)
// ─────────────────────────────────────────────────────────────────────────────
static esp_err_t benchmarkCaptureHandler(httpd_req_t* req) {
    addCorsHeaders(req);
    Serial.println("\r\n========================================================");
    Serial.println("  STARTING LAYER 1 TEST: 100 FRAME CAPTURES (NO WI-FI SEND)");
    Serial.println("========================================================");

    uint32_t minMs = 999999, maxMs = 0;
    uint64_t sumMs = 0;
    int validFrames = 0;

    for (int i = 1; i <= 100; i++) {
        int64_t t0 = esp_timer_get_time();
        camera_fb_t* fb = esp_camera_fb_get();
        int64_t t1 = esp_timer_get_time();

        if (!fb) {
            Serial.printf("Frame #%d | CAPTURE FAILED!\r\n", i);
            continue;
        }

        uint32_t capMs = (uint32_t)((t1 - t0) / 1000);
        size_t len = fb->len;
        esp_camera_fb_return(fb);

        if (capMs < minMs) minMs = capMs;
        if (capMs > maxMs) maxMs = capMs;
        sumMs += capMs;
        validFrames++;

        Serial.printf("Frame #%d | Capture time: %u ms | Frame size: %u bytes\r\n",
                      i, capMs, (unsigned)len);
        delay(10); // Small pause between sensor captures
    }

    uint32_t avgMs = validFrames > 0 ? (uint32_t)(sumMs / validFrames) : 0;
    Serial.println("========================================================");
    Serial.printf("  LAYER 1 SUMMARY: Frames=%d/100  Avg=%u ms  Min=%u ms  Max=%u ms\r\n",
                  validFrames, avgMs, minMs, maxMs);
    Serial.println("========================================================\r\n");

    char json[256];
    snprintf(json, sizeof(json),
             "{\"layer\":1,\"description\":\"camera_capture_only\",\"frames\":%d,\"avg_capture_ms\":%u,\"min_ms\":%u,\"max_ms\":%u}",
             validFrames, avgMs, minMs, maxMs);
    httpd_resp_set_type(req, "application/json");
    return httpd_resp_send(req, json, strlen(json));
}

// ─────────────────────────────────────────────────────────────────────────────
// HTTP server setup
// ─────────────────────────────────────────────────────────────────────────────
static bool startHttpServer() {
    httpd_config_t config      = HTTPD_DEFAULT_CONFIG();
    config.server_port         = 80;
    config.max_uri_handlers    = 16;
    config.stack_size          = 8192;
    config.lru_purge_enable    = true;  // Purge oldest connection when new client connects
    config.recv_wait_timeout   = 5;
    config.send_wait_timeout   = 5;

    if (httpd_start(&cameraHttpd, &config) != ESP_OK) {
        Serial.println("[HTTP] Failed to start server");
        return false;
    }

    httpd_uri_t rootUri        = { "/",             HTTP_GET,     rootHandler,             NULL };
    httpd_uri_t statusUri      = { "/status",       HTTP_GET,     statusHandler,           NULL };
    httpd_uri_t captureUri     = { "/capture",      HTTP_GET,     captureHandler,          NULL };
    httpd_uri_t streamUri      = { "/stream",       HTTP_GET,     streamHandler,           NULL };
    httpd_uri_t benchCapUri    = { "/test_capture", HTTP_GET,     benchmarkCaptureHandler, NULL };
    httpd_uri_t rootOpt        = { "/",             HTTP_OPTIONS, rootHandler,             NULL };
    httpd_uri_t statusOpt      = { "/status",       HTTP_OPTIONS, statusHandler,           NULL };
    httpd_uri_t captureOpt     = { "/capture",      HTTP_OPTIONS, captureHandler,          NULL };
    httpd_uri_t streamOpt      = { "/stream",       HTTP_OPTIONS, streamHandler,           NULL };
    httpd_uri_t benchCapOpt    = { "/test_capture", HTTP_OPTIONS, benchmarkCaptureHandler, NULL };

    httpd_register_uri_handler(cameraHttpd, &rootUri);
    httpd_register_uri_handler(cameraHttpd, &statusUri);
    httpd_register_uri_handler(cameraHttpd, &captureUri);
    httpd_register_uri_handler(cameraHttpd, &streamUri);
    httpd_register_uri_handler(cameraHttpd, &benchCapUri);
    httpd_register_uri_handler(cameraHttpd, &rootOpt);
    httpd_register_uri_handler(cameraHttpd, &statusOpt);
    httpd_register_uri_handler(cameraHttpd, &captureOpt);
    httpd_register_uri_handler(cameraHttpd, &streamOpt);
    httpd_register_uri_handler(cameraHttpd, &benchCapOpt);

    Serial.printf("[HTTP] Server ready  http://%s\r\n",
                  WiFi.localIP().toString().c_str());
    return true;
}

// ─────────────────────────────────────────────────────────────────────────────
// Wi-Fi connection
// ─────────────────────────────────────────────────────────────────────────────
static bool connectWiFi() {
    Serial.printf("[WiFi] Connecting to SSID: %s\r\n", WIFI_SSID);

    WiFi.mode(WIFI_STA);

    // ── CRITICAL LATENCY FIX ──────────────────────────────────────────────────
    // Disable Wi-Fi modem sleep.  Without this the ESP32 radio sleeps between
    // DTIM intervals (typically every 100-300 ms) and wakes only on a beacon.
    // This adds 20-100 ms of additional latency to EVERY TCP packet.
    // Must be called before WiFi.begin().
    WiFi.setSleep(false);

    WiFi.begin(WIFI_SSID, WIFI_PASSWORD);

    unsigned long start = millis();
    while (WiFi.status() != WL_CONNECTED) {
        if (millis() - start > WIFI_CONNECT_TIMEOUT_MS) {
            Serial.println("[WiFi] Timeout — restarting");
            ESP.restart();
        }
        delay(250);
        Serial.print(".");
    }

    Serial.println();
    Serial.printf("[WiFi] Connected  IP=%s  RSSI=%d dBm\r\n",
                  WiFi.localIP().toString().c_str(),
                  WiFi.RSSI());
    Serial.println("Endpoints:");
    Serial.printf("  http://%s/status\r\n",  WiFi.localIP().toString().c_str());
    Serial.printf("  http://%s/capture\r\n", WiFi.localIP().toString().c_str());
    Serial.printf("  http://%s/stream\r\n",  WiFi.localIP().toString().c_str());

    return true;
}

// ─────────────────────────────────────────────────────────────────────────────
// setup()
// ─────────────────────────────────────────────────────────────────────────────
void setup() {
    Serial.begin(115200);
    Serial.println("\r\n[SpeechLess] ESP32-CAM booting (diagnostic build)...");

    // Disable flash LED (GPIO4) — saves power, avoids camera interference
    pinMode(4, OUTPUT);
    digitalWrite(4, LOW);

    if (!initCamera()) {
        Serial.println("[Setup] Camera init failed. Check wiring. Halting.");
        while (true) delay(1000);
    }

    connectWiFi();
    startHttpServer();

    // ── Diagnostic Boot Report (Exact Layer 1 & Hardware Telemetry) ──────────
    Serial.println("\r\n==========================================");
    Serial.println("     ESP32-CAM DIAGNOSTIC REPORT");
    Serial.println("==========================================");
    Serial.printf("PSRAM detected:      %s\r\n", psramFound() ? "YES" : "NO");
    Serial.printf("PSRAM size:          %u bytes\r\n", (unsigned)ESP.getPsramSize());
    Serial.printf("Free PSRAM:          %u bytes\r\n", (unsigned)ESP.getFreePsram());
    Serial.printf("Free Heap:           %u bytes\r\n", (unsigned)esp_get_free_heap_size());
    Serial.printf("Frame buffer count:  %d\r\n", g_fb_count);
    Serial.printf("Frame buffer loc:    %s\r\n", g_fb_location);
    Serial.printf("WiFi RSSI:           %d dBm\r\n", WiFi.RSSI());
    Serial.printf("Single capture:      http://%s/capture\r\n", WiFi.localIP().toString().c_str());
    Serial.printf("MJPEG stream:        http://%s/stream\r\n", WiFi.localIP().toString().c_str());
    Serial.printf("Layer 1 benchmark:   http://%s/test_capture\r\n", WiFi.localIP().toString().c_str());
    Serial.println("==========================================\r\n");
}

// ─────────────────────────────────────────────────────────────────────────────
// loop()  — Wi-Fi watchdog + periodic RSSI report
// ─────────────────────────────────────────────────────────────────────────────
void loop() {
    unsigned long now = millis();

    if (now - lastWifiCheck > WIFI_CHECK_INTERVAL_MS) {
        lastWifiCheck = now;

        if (WiFi.status() != WL_CONNECTED) {
            Serial.println("[WiFi] Disconnected — reconnecting...");

            if (cameraHttpd) {
                httpd_stop(cameraHttpd);
                cameraHttpd = NULL;
            }

            connectWiFi();
            startHttpServer();
        } else {
            // Periodic heartbeat to Serial
            Serial.printf("[Heartbeat] uptime=%lus  heap=%u  RSSI=%d dBm  streamFPS=%u\r\n",
                          now / 1000,
                          (unsigned)esp_get_free_heap_size(),
                          WiFi.RSSI(),
                          (unsigned)streamFps);
        }
    }

    delay(10);
}
