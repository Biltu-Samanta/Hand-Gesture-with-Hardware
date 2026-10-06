# ESP32-CAM Firmware — SpeechLess

> Wi-Fi camera module for the SpeechLess hand gesture communication system.

## Overview

This folder contains an Arduino sketch (`esp32_cam_stream.ino`) that turns an **AI-Thinker ESP32-CAM** into a wireless JPEG/MJPEG camera server. The browser-based SpeechLess application connects to this device over local Wi-Fi and feeds its frames into the existing MediaPipe hand-landmark pipeline — **no changes to the gesture recognition logic are required**.

```
ESP32-CAM  ──Wi-Fi HTTP──►  Browser
                                │
                           MediaPipe Hands
                                │
                           21 landmarks
                                │
                          Gesture classifier
                                │
                           Sign → Text / Voice
```

---

## Hardware Requirements

| Item | Notes |
|------|-------|
| AI-Thinker ESP32-CAM | OV2640 sensor, built-in flash LED |
| USB-to-Serial adapter | FTDI FT232 or CH340G — **3.3 V logic** |
| 4 × dupont wires | For programming connection |
| 5 V power supply | ≥ 500 mA (USB adapter may be insufficient during Wi-Fi) |
| Local Wi-Fi router | 2.4 GHz band (ESP32 does not support 5 GHz) |

> **Note:** Any ESP32-CAM module with the OV2640 sensor and the AI-Thinker pin map should work. See the "Board Configuration" section if you have a different board.

---

## Required Arduino Libraries

Install these via **Tools → Board Manager** and **Sketch → Include Library**:

| Library | How to install |
|---------|---------------|
| `esp32` board support (Espressif) ≥ 2.0.0 | Tools → Board Manager → search "esp32" → install "esp32 by Espressif Systems" |

The following are bundled with the esp32 board support package and require **no separate installation**:
- `esp_camera.h` — camera driver
- `esp_http_server.h` — lightweight HTTP server
- `WiFi.h` — Wi-Fi stack

---

## Board Configuration

The sketch defaults to the **AI-Thinker ESP32-CAM** pin map.

If your board has different pins, edit these `#define` values near the top of `esp32_cam_stream.ino`:

```cpp
#define CAM_PIN_PWDN    32
#define CAM_PIN_RESET   -1
#define CAM_PIN_XCLK     0
// ... etc.
```

Common boards and their Arduino IDE board selection:

| Board | Arduino IDE Selection |
|-------|-----------------------|
| AI-Thinker ESP32-CAM | `AI Thinker ESP32-CAM` ← **default** |
| WROVER-KIT | `ESP32 Wrover Kit` |
| Freenove ESP32-WROVER-CAM | same pins as AI-Thinker |
| M5Stack Camera | see M5Stack documentation |

---

## Wi-Fi Configuration

Open `esp32_cam_stream.ino` and update:

```cpp
#define WIFI_SSID     "YourNetworkName"
#define WIFI_PASSWORD "YourPassword"
```

> Use your **2.4 GHz** Wi-Fi network name. The ESP32 does not connect to 5 GHz networks.

---

## Wiring (Programming Mode)

Connect the USB-to-Serial adapter to the ESP32-CAM as follows:

| USB-Serial | ESP32-CAM | Notes |
|------------|-----------|-------|
| 3.3 V or 5 V | 5 V | Use 5 V pin if adapter supports it |
| GND | GND | Common ground |
| TX | U0R (GPIO3) | Adapter TX → ESP32 RX |
| RX | U0T (GPIO1) | Adapter RX → ESP32 TX |
| GND | IO0 (GPIO0) | **Hold LOW during upload only** |

> **Important:** Tie GPIO0 to GND **before** powering on to enter flash mode. Remove the wire after uploading.

---

## Flashing Instructions

1. **Open** `esp32_cam_stream.ino` in **Arduino IDE 1.8.x or 2.x**.

2. **Configure the board:**
   - Tools → Board → **"AI Thinker ESP32-CAM"**
   - Tools → Upload Speed → **115200**
   - Tools → Port → select your USB-to-Serial adapter's COM port

3. **Enter flash mode:**
   - Connect GPIO0 to GND (see wiring table above)
   - Press and release the **RESET** button on the ESP32-CAM

4. **Upload:**
   - Click the **Upload** (→) button in Arduino IDE
   - Wait for "Hard resetting via RTS pin…" message

5. **Exit flash mode:**
   - Disconnect GPIO0 from GND
   - Press **RESET** once more to run the firmware

6. **Find the IP address:**
   - Open **Tools → Serial Monitor**
   - Set baud rate to **115200**
   - You should see output like:
     ```
     [WiFi] Connected. IP: 192.168.1.42
     ESP32-CAM ready: 192.168.1.42
     Endpoints:
       http://192.168.1.42/status
       http://192.168.1.42/capture
       http://192.168.1.42/stream
     ```

---

## HTTP Endpoints

| Endpoint | Method | Response | Use |
|----------|--------|----------|-----|
| `/` | GET | `text/plain` — "SpeechLess ESP32-CAM OK" | Root health check |
| `/status` | GET | JSON `{"status":"ok","uptime_s":...,"heap_b":...}` | Browser connectivity ping |
| `/capture` | GET | `image/jpeg` — single JPEG frame | JPEG polling fallback |
| `/stream` | GET | `multipart/x-mixed-replace` MJPEG | Primary stream |

All endpoints include `Access-Control-Allow-Origin: *` CORS headers so the browser can fetch from a different origin.

---

## Resolution and Frame Rate

| Setting | Value | Notes |
|---------|-------|-------|
| Frame size | QVGA (320×240) | Good balance of FPS vs. quality |
| JPEG quality | 12 | 0 = best, 63 = worst |
| Expected FPS | 8–12 | Wi-Fi speed dependent |

To change resolution, edit in `esp32_cam_stream.ino`:
```cpp
#define FRAME_SIZE   FRAMESIZE_QVGA   // or FRAMESIZE_CIF, FRAMESIZE_VGA
#define JPEG_QUALITY 12
```

---

## Connecting from the Browser

1. Start the SpeechLess web app (open `index.html` in Chrome).
2. In the header, change **Camera Source** from "Local Webcam" to **"ESP32-CAM"**.
3. The ESP32-CAM panel will appear below the camera feed.
4. Enter the IP address shown in Serial Monitor, e.g.: `http://192.168.1.42`
5. Click **Connect**.
6. The status indicator will turn green (●) when connected.
7. Hand gesture detection will resume automatically.

---

## Browser / CORS / Mixed-Content Limitations

> **Important:** If you open `index.html` directly as a `file://` URL, the browser
> may block cross-origin requests to the ESP32-CAM.

### Recommended setup (no limitations)

Serve the frontend over plain **HTTP** from a local dev server:

```bash
# Python 3 — simplest option
python -m http.server 8080
# Then open: http://localhost:8080
```

Since both the page (`http://localhost:8080`) and the ESP32-CAM (`http://192.168.x.x`) are plain HTTP, no mixed-content restrictions apply.

### If your page is on HTTPS

The browser will block HTTP requests from an HTTPS page ("mixed content"). The camera-source module detects this and shows a clear error message rather than silently failing. To work around it:
- Use the HTTP dev server above instead of HTTPS.
- Or enable the browser flag `chrome://flags/#unsafely-treat-insecure-origin-as-secure` (not recommended for production).

---

## Troubleshooting

| Symptom | Likely Cause | Fix |
|---------|-------------|-----|
| "ESP32-CAM unreachable" error | Wrong IP / not on same Wi-Fi | Check Serial Monitor for correct IP; ensure both devices are on the same network |
| Camera never connects to Wi-Fi | Wrong SSID/password or 5 GHz network | Check credentials; use 2.4 GHz band |
| FB-OVF errors in Serial Monitor | Frame buffer overflow | Already mitigated by the 3-frame flush loop; try lowering resolution |
| Blank / black stream | Camera init failed | Check wiring; try pressing RESET; check serial output |
| Low FPS (< 5) | Wi-Fi congestion / distance | Move ESP32-CAM closer to router; reduce JPEG quality value |
| "Mixed content blocked" | Page on HTTPS, ESP32 on HTTP | Use a local HTTP dev server (see above) |
| Upload fails in Arduino IDE | GPIO0 not held LOW during upload | Re-wire GPIO0→GND and press RESET before uploading |
| Stream stops during operation | Wi-Fi dropout | Firmware auto-reconnects within ~10 s; click "Disconnect" then "Connect" if needed |
