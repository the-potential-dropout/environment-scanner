# Genzineers Environment Scanner

Walk into a room and scan it with the phone, tablet or laptop you already have. It finds Bluetooth devices, looks for hidden camera lenses, maps the room's shape with sonar, builds a 3D point cloud, and reads every sensor your browser lets websites use. It's a web app with nothing to install, and nothing you scan leaves your device.

**▶ Open the app: https://the-potential-dropout.github.io/environment-scanner/**

Works in Chrome, Edge, Samsung Internet, Safari (macOS/iOS/iPadOS), Firefox and Opera on desktop, tablet and phone. The layout adapts: sidebar on desktop, icon rail on tablets, bottom tab bar on phones. You can also install it to your home screen.

## What it does

| Scanner | How it works | Where it works |
|---|---|---|
| **3D room scan** | **AR depth** (ARCore depth / ToF sensor, real metres), **AI depth from the camera** (Depth Anything V2, runs on your device, stitched around you with the compass), or **import a LiDAR scan** (.ply/.obj from 3D Scanner App, Polycam, Scaniverse). Orbit, top view, export .ply. | AR: Android Chrome on ARCore phones. AI + import: everywhere |
| **Bluetooth devices** | Lists nearby BLE devices, estimates distance from signal strength, hot/cold finder, flags AirTag / Find My, Tile, SmartTag trackers and likely cameras | Chrome, Edge, Samsung Internet (Android, Windows, Mac, Linux). iOS: use the Bluefy browser |
| **Hidden camera finder** | Flashlight + live image analysis circles steady pin-point lens reflections; IR mode spots night-vision LEDs | Every browser with a camera |
| **Magnetic / EMF** | Magnetometer field strength with calibration, chart and Geiger-style sound | Android Chrome (sensor flag) |
| **Sonar room mapper** | Speaker chirp + microphone echo → distance to walls; turn around to trace the room outline | Everywhere |
| **Ultrasonic & presence** | Spectrogram to the mic's limit, flags steady tones above 15 kHz; 19 kHz Doppler presence detector | Everywhere |
| **Light** | Brightness / lux, colour temperature (K), mains flicker via rolling-shutter banding | Everywhere with a camera |
| **Thermal view** | False-colour view from a USB (UVC) thermal camera | Desktop + Android with USB-C |
| **Network** | Connection type, speed estimate and live latency to find weak spots | Everywhere (details in Chromium) |
| **Motion, level & GPS** | Tilt, bubble level, vibration seismograph, compass, GPS | Phones and tablets |
| **NFC & add-ons** | Read NFC tags; connect Bluetooth Environmental Sensing devices and USB/serial boards (air quality, humidity, pressure, mmWave radar, thermal arrays…) | NFC: Android Chrome. Serial: Chrome/Edge |
| **Room map** | Combines sonar outline, marked devices, lens findings and notes; export everything as JSON | Everywhere |

The app asks for your permission in plain language before it touches any sensor, then lets the browser ask too. You can revoke permissions from the Overview page.

## Honest limits

Websites cannot read Wi‑Fi scans, cellular radio, UWB, Soli radar, the barometer, the Hall sensor, the proximity sensor, the IR blaster or the iPhone's LiDAR directly. The app tells you which ones are blocked on your device and offers the closest real alternative. **No scanner can guarantee a room is free of cameras.** Use it together with a careful physical check, and only scan places you are entitled to inspect.

## Run it locally

It's plain HTML/CSS/JS with no build step. Most sensors need HTTPS or `localhost`:

```bash
npx serve .        # or: python -m http.server 8080
```

## Licence: source-available, not open source

© 2026 Genzineers. **Free for personal, educational and non-commercial use.** Any **commercial use**, including using it in a business, for paid inspections or security sweeps, as a service, or using **modified / derivative versions**, requires a **commercial licence from Genzineers**: email **[genzineers@gmail.com](mailto:genzineers@gmail.com)** ([genzineers.com](https://genzineers.com/?utm_source=github&utm_medium=readme&utm_campaign=commercial-licence)). See [LICENSE](LICENSE). Your scans are yours.

## Made by Genzineers

Want to learn to build and launch tools and products like this? → **[thepotentialdropout.com](https://thepotentialdropout.com/?utm_source=github&utm_medium=readme&utm_campaign=env-scanner)** · **[potentialdropout.com](https://potentialdropout.com/?utm_source=github&utm_medium=readme&utm_campaign=env-scanner)** · **[genzineers.com](https://genzineers.com/?utm_source=github&utm_medium=readme&utm_campaign=env-scanner)**
